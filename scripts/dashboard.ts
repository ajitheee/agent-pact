// `npm run dashboard`: the human view of the market, live, at http://localhost:3100.
// Read-only: it streams the escrow's own event log (posted, bids, Stripe holds, verdicts), the monitor's audits
// and the output each passing delivery produced. Binds to localhost; nothing here is public.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { loadScenario, scenarioOf, type Scenario } from '../clients/scenarios.js';
import { recalledAudit, type Audit } from '../src/audit.js';
import { config } from '../src/config.js';
import { openDb, type AttemptRow, type EventRow, type TaskRow } from '../src/db.js';
import { stripeDashboardBase } from '../src/rails.js';

const PORT = Number(process.env.DASHBOARD_PORT ?? 3100);
const db = await openDb();
const stripe = await stripeDashboardBase();

const scenarios = new Map<string, Scenario>();
const scenario = (name?: string) => {
  if (!name) return undefined;
  if (!scenarios.has(name)) scenarios.set(name, loadScenario(name));
  return scenarios.get(name);
};

function taskInfo(t: TaskRow) {
  const s = scenario(scenarioOf(JSON.parse(t.verifier)));
  return {
    id: t.id,
    title: s?.title ?? t.spec.split('\n')[0].slice(0, 90),
    scenario: s?.name ?? null,
    kind: s?.kind ?? null,
    check: s?.strength ?? (t.verifier_type === 'python' ? 'Python check in a sandbox' : 'JSON Schema check'),
    budget: t.budget_max,
    created_at: t.created_at,
    deadline_at: t.deadline_at,
    status: t.status,
  };
}

const outputs = new Map<string, { worker: string; text: string } | null>();
/** The output the poster received: the scenario's show.py on the passing delivery. */
async function outputOf(taskId: string) {
  if (outputs.has(taskId)) return outputs.get(taskId)!;
  const [t] = await db.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [taskId]);
  const [a] = await db.query<AttemptRow>("SELECT * FROM attempts WHERE task_id = $1 AND outcome = 'passed'", [taskId]);
  const name = t && scenarioOf(JSON.parse(t.verifier));
  const show = name && `clients/scenarios/${name}/show.py`;
  let result: { worker: string; text: string } | null = null;
  if (a?.payload && show && existsSync(show)) {
    const out = spawnSync(config.pythonBin, ['-I', '-X', 'utf8', show], { input: a.payload, encoding: 'utf8', timeout: 20_000 });
    result = { worker: a.worker_id, text: (out.stdout || '').trimEnd() };
  }
  outputs.set(taskId, result);
  return result;
}

async function summary() {
  const [money] = await db.query<{ held: number; paid: number; blocked: number; tasks: number }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE escrow = 'held'), 0)::int AS held,
            COALESCE(SUM(amount) FILTER (WHERE escrow = 'captured'), 0)::int AS paid,
            COALESCE(SUM(amount) FILTER (WHERE escrow = 'released'), 0)::int AS blocked,
            (SELECT COUNT(*)::int FROM tasks WHERE poster_id = 'poster') AS tasks
     FROM attempts`,
  );
  const audits = await db.query<{ value: string }>("SELECT value FROM kv WHERE key LIKE 'audit:%'");
  const cheats = audits.reduce((n, r) => n + (JSON.parse(r.value) as Audit).flags.filter((f) => f.kind === 'cheat').length, 0);
  const agents = await db.query<{ worker_id: string; passed: number; total: number }>(
    "SELECT worker_id, COUNT(*) FILTER (WHERE outcome = 'passed')::int AS passed, COUNT(*)::int AS total FROM attempts WHERE outcome IN ('passed', 'failed', 'timed_out') GROUP BY worker_id",
  );
  const watch = await db.query<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'watch:%'");
  const tasks = await db.query<TaskRow>("SELECT * FROM tasks WHERE poster_id = 'poster' ORDER BY created_at DESC LIMIT 40");
  return {
    money: { ...money, cheats },
    agents: agents.map((a) => ({ id: a.worker_id, passed: a.passed, total: a.total })),
    watchlist: watch.map((w) => ({ id: w.key.slice(6), flags: (JSON.parse(w.value) as { label: string }[]).map((f) => f.label) })),
    tasks: tasks.map(taskInfo),
    stripe,
  };
}

async function taskDetail(id: string) {
  const [t] = await db.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]);
  if (!t) return null;
  const events = await db.query<EventRow>('SELECT * FROM events WHERE task_id = $1 ORDER BY seq', [id]);
  const attempts = await db.query<AttemptRow>('SELECT * FROM attempts WHERE task_id = $1 ORDER BY created_at', [id]);
  return {
    task: { ...taskInfo(t), spec: t.spec },
    events: events.map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, at: e.at, data: JSON.parse(e.data) })),
    payments: attempts.map((a) => ({ worker: a.worker_id, amount: a.amount, escrow: a.escrow, outcome: a.outcome, url: `${stripe}/payments/${a.payment_intent}` })),
    audit: (await recalledAudit(db, id)) ?? null,
    output: await outputOf(id),
  };
}

// Live stream: new events on the poster's tasks, then each passing delivery's output and the monitor's audit.
const clients = new Set<ServerResponse>();
const send = (type: string, payload: unknown) => {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(frame);
};
let [{ cursor }] = await db.query<{ cursor: number }>('SELECT COALESCE(MAX(seq), 0)::int AS cursor FROM events');
const awaitingAudit = new Set<string>();
let busy = false;
setInterval(async () => {
  if (busy || clients.size === 0) return;
  busy = true;
  try {
    const rows = await db.query<EventRow & { t: string }>(
      "SELECT e.*, row_to_json(t.*)::text AS t FROM events e JOIN tasks t ON t.id = e.task_id WHERE e.seq > $1 AND t.poster_id = 'poster' ORDER BY e.seq",
      [cursor],
    );
    for (const e of rows) {
      cursor = Math.max(cursor, e.seq);
      const task = taskInfo(JSON.parse(e.t) as TaskRow);
      send('event', { seq: e.seq, type: e.type, actor: e.actor, at: e.at, data: JSON.parse(e.data), task });
      if (e.type === 'passed') {
        const output = await outputOf(e.task_id);
        if (output) send('output', { task_id: e.task_id, ...output });
      }
      if (e.type === 'passed' || e.type === 'expired') awaitingAudit.add(e.task_id);
    }
    for (const id of awaitingAudit) {
      const audit = await recalledAudit(db, id);
      if (audit) {
        awaitingAudit.delete(id);
        send('audit', { task_id: id, audit });
        send('summary', await summary());
      }
    }
  } catch (e) {
    console.error('[dashboard]', (e as Error).message);
  } finally {
    busy = false;
  }
}, 400);
setInterval(() => {
  for (const c of clients) c.write(': keep-alive\n\n');
}, 15_000);

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync('dashboard/index.html'));
    }
    if (url.pathname === '/studio') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync('dashboard/studio.html'));
    }
    if (url.pathname === '/api/summary') return json(res, await summary());
    if (url.pathname.startsWith('/api/task/')) {
      const detail = await taskDetail(decodeURIComponent(url.pathname.slice('/api/task/'.length)));
      return detail ? json(res, detail) : json(res, { error: 'no such task' }, 404);
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    json(res, { error: 'not found' }, 404);
  } catch (e) {
    json(res, { error: (e as Error).message }, 500);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`AgentPact dashboard: http://localhost:${PORT}`));
