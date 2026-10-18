// The monitor: an independent audit of one finished task, run after the market has settled it.
//
// It trusts nothing the market recorded. It replays the event log to check every step happened in order,
// matches each escrow hold to its verdict in the database and on Stripe, and re-runs the task's check on
// every stored delivery (with fresh random inputs where the check has them). Then it looks for cheating:
// tests gamed by special-casing the visible ones, invented data, sandbox escapes, and a "new" worker whose
// delivery is byte-identical to another worker's. The audit is saved in the pact's memory (kv
// audit:<task_id>) and cheats go on a per-worker watchlist (kv watch:<worker_id>).
import type { AttemptRow, Db, EventRow, TaskRow } from './db.js';
import { config } from './config.js';
import { usd } from './market.js';
import { Verifiers, type VerifierSpec } from './verifier/index.js';

export interface AuditCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AuditFlag {
  worker: string;
  /** cheat: dishonest delivery. failed: honest failure (sloppy work, no delivery). note: worth knowing. */
  kind: 'cheat' | 'failed' | 'note';
  label: string;
  detail: string;
}

export interface Audit {
  task_id: string;
  audited_at: string;
  /** clean: steps and money check out, no cheats. flagged: money checks out, a worker cheated. broken: a step or payment doesn't add up. */
  verdict: 'clean' | 'flagged' | 'broken';
  checks: AuditCheck[];
  flags: AuditFlag[];
  /** Each involved worker's record across every task: passed / attempted. */
  records: Record<string, string>;
}

/** Failure reasons that mean the worker tried to game the check, not just did poor work. */
const CHEATS: { pattern: RegExp; label: string; detail: string }[] = [
  { pattern: /^hidden test:/, label: 'gamed the tests', detail: 'passed every visible test but failed hidden ones: it special-cased the tests instead of doing the work' },
  { pattern: /not in the directory|invented/, label: 'invented data', detail: "delivered data that isn't in the source" },
  { pattern: /sandbox: |is not allowed/, label: 'sandbox escape', detail: 'tried to break out of the sandbox' },
];

export async function auditTask(db: Db, taskId: string, opts: { verifiers?: Verifiers; stripeKey?: string } = {}): Promise<Audit> {
  const [task] = await db.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [taskId]);
  if (!task) throw new Error(`no task ${taskId}`);
  const events = await db.query<EventRow>('SELECT * FROM events WHERE task_id = $1 ORDER BY seq', [taskId]);
  const attempts = await db.query<AttemptRow>('SELECT * FROM attempts WHERE task_id = $1 ORDER BY created_at', [taskId]);
  const bids = await db.query<{ id: string; worker_id: string; eta_seconds: number }>('SELECT id, worker_id, eta_seconds FROM bids WHERE task_id = $1', [taskId]);
  const checks: AuditCheck[] = [];
  const flags: AuditFlag[] = [];

  checks.push(stepsInOrder(task, events));
  checks.push(escrowMatchesVerdicts(attempts));
  const stripeKey = opts.stripeKey ?? config.stripeKey;
  if (stripeKey && attempts.some((a) => !a.payment_intent.startsWith('pi_fake'))) checks.push(await stripeAgrees(attempts, stripeKey));
  checks.push(await recheck(task, attempts, opts.verifiers ?? new Verifiers()));

  for (const a of attempts) {
    if (a.outcome === 'failed') {
      const cheat = CHEATS.find((c) => c.pattern.test(a.reason ?? ''));
      flags.push(cheat ? { worker: a.worker_id, kind: 'cheat', label: cheat.label, detail: cheat.detail } : { worker: a.worker_id, kind: 'failed', label: 'failed the check', detail: clip(a.reason ?? '', 110) });
    }
    if (a.outcome === 'timed_out') flags.push({ worker: a.worker_id, kind: 'failed', label: 'no delivery', detail: 'took the job and never delivered' });
    if (a.payload) {
      // A brand-new identity delivering exactly what another identity delivered before is one operator with two names.
      const [twin] = await db.query<{ worker_id: string; task_id: string }>(
        'SELECT worker_id, task_id FROM attempts WHERE payload = $1 AND worker_id <> $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 1',
        [a.payload, a.worker_id, a.created_at],
      );
      if (twin) flags.push({ worker: a.worker_id, kind: 'cheat', label: 'same operator?', detail: `delivery is identical to ${twin.worker_id}'s on ${twin.task_id}` });
    }
    const [{ n: earlier }] = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM attempts WHERE worker_id = $1 AND created_at < $2', [a.worker_id, a.created_at]);
    if (earlier === 0) flags.push({ worker: a.worker_id, kind: 'note', label: 'new identity', detail: 'first job ever, no track record' });
    const eta = bids.find((b) => b.id === a.bid_id)?.eta_seconds;
    if (eta !== undefined && a.resolved_at && (a.resolved_at - a.created_at) / 1000 > eta) {
      flags.push({ worker: a.worker_id, kind: 'note', label: 'late', detail: `delivered after its own ${eta}s ETA` });
    }
  }

  const records: Record<string, string> = {};
  for (const worker of new Set(attempts.map((a) => a.worker_id))) {
    const [r] = await db.query<{ passed: number; total: number }>(
      "SELECT COUNT(*) FILTER (WHERE outcome = 'passed')::int AS passed, COUNT(*)::int AS total FROM attempts WHERE worker_id = $1 AND outcome IN ('passed', 'failed', 'timed_out')",
      [worker],
    );
    records[worker] = `${r.passed}/${r.total}`;
  }

  const verdict = checks.some((c) => !c.ok) ? 'broken' : flags.some((f) => f.kind === 'cheat') ? 'flagged' : 'clean';
  const audit: Audit = { task_id: taskId, audited_at: new Date().toISOString(), verdict, checks, flags, records };
  await remember(db, audit);
  return audit;
}

/** Posted first; every award follows a bid from that worker; awards and verdicts alternate; the status matches the outcome. */
function stepsInOrder(task: TaskRow, events: EventRow[]): AuditCheck {
  const name = 'steps in order';
  const problems: string[] = [];
  if (events[0]?.type !== 'posted') problems.push('the log does not start with the posting');
  const bidders = new Set<string>();
  let awardedTo: string | null = null;
  let passes = 0;
  const path: string[] = [];
  for (const e of events) {
    const d = JSON.parse(e.data) as Record<string, any>;
    if (e.type === 'bid' || e.type === 'rebid') bidders.add(e.actor);
    if (e.type === 'awarded') {
      if (awardedTo) problems.push(`awarded to ${d.worker} while ${awardedTo} still held it`);
      if (!bidders.has(d.worker)) problems.push(`awarded to ${d.worker}, who never bid`);
      awardedTo = d.worker;
      path.push(`award ${d.worker}`);
    }
    if (e.type === 'passed' || e.type === 'failed' || e.type === 'timed_out') {
      const worker = e.type === 'timed_out' ? d.worker : e.actor;
      if (worker !== awardedTo) problems.push(`a verdict for ${worker}, who didn't hold the task`);
      awardedTo = null;
      if (e.type === 'passed') passes++;
      path.push(e.type === 'passed' ? 'pass' : e.type === 'failed' ? 'fail' : 'no delivery');
    }
  }
  if (passes > 1) problems.push(`${passes} passing deliveries for one task`);
  if ((task.status === 'completed') !== (passes === 1)) problems.push(`status ${task.status} with ${passes} passing deliveries`);
  const detail = problems.length ? problems.join('; ') : `posted → ${bidders.size} bid${bidders.size === 1 ? '' : 's'} → ${path.join(' → ')} → ${task.status}`;
  return { name, ok: problems.length === 0, detail };
}

/** A pass must have captured its hold; a fail or a missed deadline must have released it. */
function escrowMatchesVerdicts(attempts: AttemptRow[]): AuditCheck {
  const wrong = attempts.filter((a) => (a.outcome === 'passed' ? a.escrow !== 'captured' : a.outcome === 'held' ? a.escrow !== 'held' : a.escrow !== 'released'));
  const captured = attempts.filter((a) => a.escrow === 'captured').length;
  const released = attempts.filter((a) => a.escrow === 'released').length;
  return {
    name: 'escrow = verdicts',
    ok: wrong.length === 0,
    detail: wrong.length
      ? wrong.map((a) => `${a.worker_id}: ${a.outcome} but escrow ${a.escrow}`).join('; ')
      : `${attempts.length} hold${attempts.length === 1 ? '' : 's'}: ${released} released on a fail, ${captured} captured on a pass`,
  };
}

/** Stripe is the source of truth for money: a captured hold succeeded for the full amount, a released one was canceled. */
async function stripeAgrees(attempts: AttemptRow[], key: string): Promise<AuditCheck> {
  const problems: string[] = [];
  const seen: string[] = [];
  for (const a of attempts.filter((x) => !x.payment_intent.startsWith('pi_fake'))) {
    const res = await fetch(`https://api.stripe.com/v1/payment_intents/${a.payment_intent}`, { headers: { authorization: `Bearer ${key}` } });
    const pi = (await res.json()) as { status?: string; amount?: number; amount_received?: number; metadata?: Record<string, string>; error?: { message: string } };
    if (!pi.status) {
      problems.push(`${a.payment_intent}: ${pi.error?.message ?? `HTTP ${res.status}`}`);
      continue;
    }
    if (pi.amount !== a.amount) problems.push(`${a.worker_id}: Stripe holds ${usd(pi.amount ?? 0)}, the bid was ${usd(a.amount)}`);
    if (a.escrow === 'captured' && (pi.status !== 'succeeded' || pi.amount_received !== a.amount)) problems.push(`${a.worker_id}: marked captured, Stripe says ${pi.status}`);
    if (a.escrow === 'released' && pi.status !== 'canceled') problems.push(`${a.worker_id}: marked released, Stripe says ${pi.status}`);
    const verdict = pi.metadata?.verdict;
    if (a.outcome !== 'held' && verdict && verdict !== (a.outcome === 'passed' ? 'pass' : a.outcome === 'failed' ? 'fail' : a.outcome)) {
      problems.push(`${a.worker_id}: Stripe records verdict ${verdict}, the market ${a.outcome}`);
    }
    seen.push(`${a.worker_id} ${pi.status} ${usd(pi.amount ?? 0)}`);
  }
  return { name: 'Stripe agrees', ok: problems.length === 0, detail: problems.length ? problems.join('; ') : seen.join(' · ') };
}

/** Run the task's check again on every stored delivery. Checks with random inputs draw new ones, so a lucky pass would show. */
async function recheck(task: TaskRow, attempts: AttemptRow[], verifiers: Verifiers): Promise<AuditCheck> {
  const spec = JSON.parse(task.verifier) as VerifierSpec;
  const delivered = attempts.filter((a) => a.payload && (a.outcome === 'passed' || a.outcome === 'failed'));
  const problems: string[] = [];
  const where = new Set<string>();
  for (const a of delivered) {
    const verdict = await verifiers.run(spec, JSON.parse(a.payload!));
    where.add(verdict.sandbox === 'blaxel' ? 'Blaxel' : verdict.sandbox === 'local' ? 'the local sandbox' : 'the schema validator');
    if (verdict.passed !== (a.outcome === 'passed')) problems.push(`${a.worker_id}: recorded ${a.outcome}, re-check says ${verdict.passed ? 'pass' : 'fail'}`);
  }
  return {
    name: 're-checked',
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${delivered.length} deliver${delivered.length === 1 ? 'y' : 'ies'} re-run in ${[...where].join(' and ') || 'the sandbox'}: same verdicts`,
  };
}

/** The pact's memory: the audit itself, and a watchlist entry for every worker caught cheating. */
async function remember(db: Db, audit: Audit) {
  const put = (key: string, value: unknown) =>
    db.query('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, JSON.stringify(value)]);
  await put(`audit:${audit.task_id}`, audit);
  for (const f of audit.flags.filter((x) => x.kind === 'cheat')) {
    const [row] = await db.query<{ value: string }>('SELECT value FROM kv WHERE key = $1', [`watch:${f.worker}`]);
    const list = (row ? JSON.parse(row.value) : []) as { task_id: string; label: string; detail: string; at: string }[];
    if (!list.some((x) => x.task_id === audit.task_id && x.label === f.label)) list.push({ task_id: audit.task_id, label: f.label, detail: f.detail, at: audit.audited_at });
    await put(`watch:${f.worker}`, list);
  }
}

export async function recalledAudit(db: Db, taskId: string): Promise<Audit | undefined> {
  const [row] = await db.query<{ value: string }>('SELECT value FROM kv WHERE key = $1', [`audit:${taskId}`]);
  return row ? (JSON.parse(row.value) as Audit) : undefined;
}

/** The audit as terminal lines, for npm run live and npm run audit. */
export function formatAudit(audit: Audit, paint: (code: string, s: string) => string = (_c, s) => s): string[] {
  const cheats = audit.flags.filter((f) => f.kind === 'cheat').length;
  const headline = { clean: paint('32;1', 'CLEAN'), flagged: paint('33;1', 'FLAGGED'), broken: paint('31;1', 'BROKEN') }[audit.verdict];
  const lines = [paint('1', `Monitor audit for ${audit.task_id}: `) + headline + paint('2', audit.verdict === 'broken' ? '' : ` (steps and payments check out${cheats ? `, ${cheats} cheat flag${cheats > 1 ? 's' : ''}` : ''})`)];
  for (const c of audit.checks) lines.push(`  ${c.ok ? paint('32', '✓') : paint('31', '✗')} ${c.name.padEnd(18)} ${c.detail}`);
  for (const f of audit.flags) {
    const mark = f.kind === 'cheat' ? paint('33', '⚑') : f.kind === 'failed' ? paint('31', '✗') : paint('2', '·');
    lines.push(`  ${mark} ${f.worker.padEnd(18)} ${f.kind === 'note' ? paint('2', `${f.label}: ${f.detail}`) : `${f.label}: ${f.detail}`}`);
  }
  const records = Object.entries(audit.records).map(([w, r]) => `${w} ${r}`).join(' · ');
  lines.push(paint('2', `  memory: records ${records} · saved as audit:${audit.task_id}${cheats ? ', cheats added to the watchlist' : ''}`));
  return lines;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
