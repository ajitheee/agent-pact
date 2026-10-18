// `npm run replay-page -- <out.html>`: the dashboard as one public page that replays the recorded runs.
// Reads the running dashboard (`npm run dashboard`) and bakes its data into the page, so the page needs no server.
// Only jobs from the three real workloads go in, and nothing private: no Stripe account or payment links, no
// database details. The build refuses to write a page whose data matches any of those.
import { readFileSync, writeFileSync } from 'node:fs';

type Payment = { worker: string; amount: number; escrow: string; outcome: string; url?: string };
type Detail = { task: { id: string }; events: { type: string }[]; payments: Payment[]; audit: { flags: { kind: string }[] } | null; output: unknown };
type TaskInfo = { id: string; scenario: string | null; status: string };

const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3100';
const out = process.argv[2] ?? 'replay.html';
const SCENARIOS = new Set(['ci-fix', 'sql-report', 'invoices']);
const get = async <T>(path: string): Promise<T> => {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} (is npm run dashboard running?)`);
  return r.json() as Promise<T>;
};

const summary = await get<{ agents: unknown[]; watchlist: unknown[]; tasks: TaskInfo[] }>('/api/summary');
const tasks = summary.tasks.filter((t) => t.scenario && SCENARIOS.has(t.scenario) && ['completed', 'expired'].includes(t.status));
const details: Record<string, Detail> = {};
for (const t of tasks) {
  const d = await get<Detail>('/api/task/' + encodeURIComponent(t.id));
  details[t.id] = { ...d, payments: d.payments.map(({ url: _stripeLink, ...p }) => p) };
}

// The header totals count only the jobs on this page.
const payments = Object.values(details).flatMap((d) => d.payments);
const total = (escrow: string) => payments.filter((p) => p.escrow === escrow).reduce((n, p) => n + p.amount, 0);
const cheats = Object.values(details).reduce((n, d) => n + (d.audit?.flags ?? []).filter((f) => f.kind === 'cheat').length, 0);
const money = { held: total('held'), paid: total('captured'), blocked: total('released'), cheats };
// Opens on a CI-fix job where a cheat was caught and the honest worker was paid.
const featured =
  tasks.find((t) => t.scenario === 'ci-fix' && t.status === 'completed' && details[t.id].events.some((e) => e.type === 'failed'))?.id ?? tasks[0]?.id;

const data = JSON.stringify({ summary: { money, agents: summary.agents, watchlist: summary.watchlist, tasks }, details, featured });
for (const secret of [/acct_[A-Za-z0-9]+/, /dashboard\.stripe\.com/, /\b[sr]k_(live|test)_/, /\bpk_live_/, /postgres(ql)?:\/\//, /supabase\.co/i, /pooler/i]) {
  if (secret.test(data)) throw new Error(`refusing to build: the data matches ${secret}`);
}

const page = readFileSync('dashboard/index.html', 'utf8');
const pick = (re: RegExp) => {
  const m = page.match(re);
  if (!m) throw new Error(`dashboard/index.html no longer matches ${re}`);
  return m[1];
};
// The artifact host adds the document skeleton; this look is dark only.
const style = pick(/<style>([\s\S]*?)<\/style>/).replace(':root {', ':root { color-scheme: dark;').replace('height: 100vh', 'height: 100%');
const body = pick(/<body>([\s\S]*?)<script>/);
const script = pick(/<script>([\s\S]*?)<\/script>/);
const shim = `window.REPLAY = ${data.replace(/</g, '\\u003c')};
// The dashboard asks its server for data; here the answers come from the recorded runs above.
const serverFetch = window.fetch.bind(window);
window.fetch = async (url, options) => {
  const path = String(url);
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/api/summary') return reply(window.REPLAY.summary);
  if (path.startsWith('/api/task/')) {
    const d = window.REPLAY.details[decodeURIComponent(path.slice('/api/task/'.length))];
    return d ? reply(d) : reply({ error: 'no such task' }, 404);
  }
  return serverFetch(url, options);
};`;

writeFileSync(out, `<title>AgentPact Replay</title>\n<style>${style}</style>\n${body}<script>\n${shim}\n</script>\n<script>${script}</script>\n`);
console.log(`${out}: ${tasks.length} jobs (${[...new Set(tasks.map((t) => t.scenario))].join(', ')}), opens on ${featured}, ${(Buffer.byteLength(data) / 1024).toFixed(0)} KB of data`);
