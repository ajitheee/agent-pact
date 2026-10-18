// `npm run live`: the whole demo in one terminal, against the server in clients/tokens.local.json
// (production after `npm run setup:clients -- --url …`). For rehearsals and the backup video.
//
//   worker-a        mcp-use client, honest: bids 150¢ / 90s, delivers contacts that pass
//   mallory-xxxx    mcp-use client, cheapest: bids 55¢ / 30s, delivers free-mail garbage. A fresh identity each
//                   run, so every take shows "new agent gets a shot, fails, refunded" instead of a known bad actor.
//   poster          Claude Code: posts the task, picks the cheapest bid that fits the deadline (Mallory), sees
//                   her fail and get refunded, filters by reputation, re-awards to worker A, who gets paid.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mintToken } from '../src/agents.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { newId } from '../src/ids.js';
import { usd } from '../src/market.js';

const tokens = JSON.parse(readFileSync('clients/tokens.local.json', 'utf8')) as Record<string, string>;
const paint = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const started = Date.now();
const clock = () => paint('2', `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`);

// A fresh Mallory, registered straight in the shared database.
const db = await openDb();
const mallory = newId('mallory', 4).replace('_', '-');
const domain = config.escrowEmail.split('@')[1];
const malloryToken = await mintToken(db, mallory, domain ? { email: `${mallory}@${domain}` } : {});
await db.close();

console.log(paint('1', `\nAgent Task Escrow · live run against ${tokens.url}`));
console.log(paint('2', `poster = Claude Code · worker-a = mcp-use client · ${mallory} = mcp-use client (fresh, cheapest, junk)\n`));
await warmUp();

/**
 * Wake the server, its database pool and the Python sandbox before the cameras roll. A Python verifier
 * without verify() runs in the real sandbox but is rejected at post time, so no task or email is created.
 */
async function warmUp() {
  const t0 = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(tokens.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          authorization: `Bearer ${tokens.poster}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'post_task', arguments: { spec: 'warm-up', budget_max: 50, deadline: 30, verifier: { type: 'python', code: 'warm_up = True' } } },
        }),
      });
      if ((await res.text()).includes('must define a function verify')) {
        console.log(paint('2', `warm-up: server, database and Python sandbox ready (${Date.now() - t0}ms)\n`));
        return;
      }
    } catch {
      /* retry below */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(paint('33', 'warm-up: the server did not confirm its Python sandbox; continuing anyway\n'));
}

const node = (args: string[], env: Record<string, string> = {}) =>
  spawn(process.execPath, ['--env-file-if-exists=.env', '--disable-warning=ExperimentalWarning', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });

const children: ChildProcess[] = [];
function attach(name: string, color: string, child: ChildProcess, strip = /^\d\d:\d\d:\d\d \[[^\]]+\] /) {
  children.push(child);
  const label = paint(color, name.padStart(13));
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => {
      const text = line.replace(strip, '');
      if (text.trim() && !text.startsWith('>')) console.log(`${clock()} ${label}  ${text}`);
    });
  }
  return new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

const workerA = attach('worker-a', '32', node(['--import', 'tsx', 'clients/worker-a.ts', '--once']));
const malloryDone = attach(
  mallory,
  '35',
  node(['--import', 'tsx', 'clients/worker-a.ts', '--as', mallory, '--price', '55', '--eta', '30', '--garbage', '--once'], { ESCROW_AGENT_TOKEN: malloryToken }),
);
await new Promise((r) => setTimeout(r, 4000)); // let both workers connect before the task exists
const poster = attach('poster', '36', node(['scripts/run-poster.mjs', '--stream']), /^\[poster\] /);

const posterExit = await poster;
await Promise.race([Promise.all([workerA, malloryDone]), new Promise((r) => setTimeout(r, 15_000))]);
for (const c of children) if (c.exitCode === null) c.kill();

// Settlement, straight from the database: every escrow hold on the poster's latest task.
const summary = await openDb();
const [task] = await summary.query<{ id: string; status: string }>("SELECT id, status FROM tasks WHERE poster_id = 'poster' ORDER BY created_at DESC LIMIT 1");
if (task) {
  console.log(paint('1', `\nSettlement for ${task.id} (${task.status})`));
  const attempts = await summary.query<{ worker_id: string; amount: number; outcome: string; escrow: string; payment_intent: string; reason: string | null }>(
    'SELECT worker_id, amount, outcome, escrow, payment_intent, reason FROM attempts WHERE task_id = $1 ORDER BY created_at',
    [task.id],
  );
  for (const a of attempts) {
    const verdict = a.outcome === 'passed' ? paint('32', 'PASS') : paint('31', a.outcome.toUpperCase());
    console.log(`  ${a.worker_id.padEnd(13)} ${usd(a.amount).padStart(6)}  ${verdict}  escrow ${a.escrow.padEnd(9)} https://dashboard.stripe.com/test/payments/${a.payment_intent}`);
    if (a.reason) console.log(paint('2', `  ${''.padEnd(13)} ${a.reason}`));
  }
}
await summary.close();
console.log(paint('2', `\nDone in ${Math.round((Date.now() - started) / 1000)}s.`));
process.exit(posterExit);
