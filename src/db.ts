import { mkdirSync } from 'node:fs';
import postgres from 'postgres';

export type TaskStatus = 'open' | 'awarded' | 'completed' | 'expired';
export type BidStatus = 'pending' | 'accepted' | 'won' | 'failed' | 'lost';
export type AttemptOutcome = 'held' | 'passed' | 'failed' | 'timed_out';
export type EscrowStatus = 'held' | 'captured' | 'released' | 'release_failed';

export interface AgentRow {
  id: string;
  token_hash: string;
  email: string | null;
  stripe_account: string | null;
  created_at: number;
}

export interface TaskRow {
  id: string;
  poster_id: string;
  spec: string;
  capability: string | null;
  verifier_type: 'json_schema' | 'python';
  verifier: string; // JSON of the prepared VerifierSpec
  budget_max: number; // US cents
  deadline_at: number; // epoch ms
  status: TaskStatus;
  current_attempt_id: string | null;
  created_at: number;
  seq: number; // last event touching this task; drives `since` cursors
}

export interface BidRow {
  id: string;
  task_id: string;
  worker_id: string;
  price: number;
  eta_seconds: number;
  status: BidStatus;
  created_at: number;
  seq: number;
}

/** One award of a task to a worker: the escrow hold and its verdict. */
export interface AttemptRow {
  id: string;
  task_id: string;
  bid_id: string;
  worker_id: string;
  amount: number;
  payment_intent: string;
  escrow: EscrowStatus;
  outcome: AttemptOutcome;
  reason: string | null;
  payload: string | null;
  created_at: number;
  resolved_at: number | null;
}

export interface EventRow {
  seq: number;
  task_id: string;
  actor: string;
  type: string;
  data: string;
  at: number;
}

export interface Queryable {
  /** Parameterized query with $1, $2… placeholders. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Postgres, either Supabase (DATABASE_URL) or PGlite in-process for local runs and tests.
 * Times are DOUBLE PRECISION epoch ms and counts are cast to ::int, so both drivers return plain numbers.
 */
export interface Db extends Queryable {
  readonly kind: 'postgres' | 'pglite';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT,
    stripe_account TEXT,
    created_at DOUBLE PRECISION NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    poster_id TEXT NOT NULL,
    spec TEXT NOT NULL,
    capability TEXT,
    verifier_type TEXT NOT NULL,
    verifier TEXT NOT NULL,
    budget_max INTEGER NOT NULL,
    deadline_at DOUBLE PRECISION NOT NULL,
    status TEXT NOT NULL,
    current_attempt_id TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, deadline_at)`,
  `CREATE INDEX IF NOT EXISTS tasks_seq ON tasks (seq)`,
  `CREATE TABLE IF NOT EXISTS bids (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    worker_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    eta_seconds INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE (task_id, worker_id)
  )`,
  `CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    bid_id TEXT NOT NULL REFERENCES bids (id),
    worker_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    payment_intent TEXT NOT NULL,
    escrow TEXT NOT NULL,
    outcome TEXT NOT NULL,
    reason TEXT,
    payload TEXT,
    created_at DOUBLE PRECISION NOT NULL,
    resolved_at DOUBLE PRECISION
  )`,
  `CREATE INDEX IF NOT EXISTS attempts_worker ON attempts (worker_id, outcome)`,
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    at DOUBLE PRECISION NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq)`,
  // Email transport: one Primitive thread per task, every message we sent, and inbound mail already handled.
  `CREATE TABLE IF NOT EXISTS email_threads (
    task_id TEXT PRIMARY KEY,
    root_sent_id TEXT NOT NULL,
    root_message_id TEXT,
    subject TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS email_sent (
    sent_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS email_inbox (
    email_id TEXT PRIMARY KEY,
    sender TEXT,
    command TEXT,
    outcome TEXT,
    received_at DOUBLE PRECISION NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Supabase exposes the public schema over its REST API. RLS with no policies shuts that door;
  // this service connects as the table owner, which bypasses RLS.
  ...['agents', 'tasks', 'bids', 'attempts', 'events', 'email_threads', 'email_sent', 'email_inbox', 'kv'].map(
    (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
  ),
];

export async function openDb(opts: { url?: string | null; dir?: string | null } = {}): Promise<Db> {
  const url = opts.url === undefined ? process.env.DATABASE_URL : opts.url;
  const dir = opts.dir === undefined ? (process.env.PGLITE_DIR ?? '.data/pglite') : opts.dir;
  const db = url ? postgresDb(url) : await pgliteDb(dir ?? undefined);
  await db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(727201)'); // concurrent instances migrate one at a time
    for (const statement of SCHEMA) await q.query(statement);
  });
  return db;
}

/** A pooled connection the network dropped while the host sat idle; the next attempt gets a fresh one. */
function isDroppedConnection(e: unknown) {
  const code = (e as { code?: string })?.code ?? '';
  return ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code) || /ECONNRESET|Connection terminated/i.test(String(e));
}

function postgresDb(url: string): Db {
  // prepare:false keeps Supabase's transaction pooler (port 6543) happy.
  const sql = postgres(url, { prepare: false, max: 5, idle_timeout: 20, onnotice: () => {} });
  const run = <T>(s: postgres.Sql | postgres.TransactionSql, text: string, params: unknown[]) =>
    s.unsafe(text, params as postgres.ParameterOrJSON<never>[]) as unknown as Promise<T[]>;
  return {
    kind: 'postgres',
    // Plain queries are retried on a dropped connection (each pooled connection can be stale after idling).
    query: async <T>(text: string, params: unknown[] = []) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await run<T>(sql, text, params);
        } catch (e) {
          if (attempt >= 3 || !isDroppedConnection(e)) throw e;
        }
      }
    },
    // A transaction is retried only when its first statement hit a dead connection: nothing in it
    // (a Stripe hold, say) can have run yet, so the retry cannot double-apply anything.
    tx: async <T>(fn: (q: Queryable) => Promise<T>) => {
      for (let attempt = 1; ; attempt++) {
        let started = false;
        try {
          return (await sql.begin((t) =>
            fn({
              query: async <R>(text: string, params: unknown[] = []) => {
                const rows = await run<R>(t, text, params);
                started = true;
                return rows;
              },
            }),
          )) as T;
        } catch (e) {
          if (started || attempt >= 3 || !isDroppedConnection(e)) throw e;
        }
      }
    },
    close: () => sql.end(),
  };
}

async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) mkdirSync(dataDir, { recursive: true }); // PGlite only creates the last path segment
  const pg = await PGlite.create(dataDir);
  type Runner = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  const wrap = (s: Runner): Queryable => ({
    query: async <T>(text: string, params: unknown[] = []) => (await s.query(text, params)).rows as T[],
  });
  return {
    kind: 'pglite',
    ...wrap(pg),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}
