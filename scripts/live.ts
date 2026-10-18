// `npm run live`: the whole demo in one terminal, against the server in clients/tokens.local.json
// (production after `npm run setup:clients -- --url …`). For rehearsals and the backup video.
//
//   worker-a        mcp-use client, honest: bids 150¢ / 90s, delivers a slugify() that passes the tests
//   mallory-xxxx    mcp-use client, cheapest: bids 55¢ / 30s, delivers a slugify() that only looks finished. A fresh identity each
//                   run, so every take shows "new agent gets a shot, fails, refunded" instead of a known bad actor.
//   poster          Claude Code: posts the task, picks the cheapest bid that fits the deadline (Mallory), sees
//                   her fail and get refunded, filters by reputation, re-awards to worker A, who gets paid.
//
//   npm run live -- --with-worker-b   adds the third client: worker B in Claude Desktop (escrow-worker-b server).
//                   Its prompt goes on the clipboard. Paste and send it before the poster starts: worker B
//                   long-polls list_open_tasks, so it bids as soon as the task exists. The poster waits for
//                   3 bids, and worker B's 80¢ / 300s bid loses on the 240s deadline.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { mintToken } from '../src/agents.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { newId } from '../src/ids.js';
import { usd } from '../src/market.js';
import { stripeDashboardBase } from '../src/rails.js';

const tokens = JSON.parse(readFileSync('clients/tokens.local.json', 'utf8')) as Record<string, string>;
const withWorkerB = process.argv.includes('--with-worker-b');
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
console.log(
  paint('2', `poster = Claude Code · worker-a = mcp-use client · ${mallory} = mcp-use client (fresh, cheapest, junk)${withWorkerB ? ' · worker-b = Claude Desktop' : ''}\n`),
);
await warmUp();
if (withWorkerB) await readyWorkerB();

/** Worker B is driven by a person, so its prompt goes in before the task exists; it then waits for the task on its own. */
async function readyWorkerB() {
  // --no-pause: worker B's prompt was already sent (for example by another Claude session) and it is waiting.
  if (process.argv.includes('--no-pause')) {
    console.log(paint('33;1', '  ▶ Worker B (Claude Desktop) is already waiting for the task.\n'));
    return;
  }
  if (!process.argv.includes('--no-clipboard')) {
    // Copied right at the pause, so nothing copied during the warm-up replaces it.
    spawn('powershell', ['-NoProfile', '-Command', "Get-Content -Raw 'clients/worker-b.md' | Set-Clipboard"], { stdio: 'ignore' });
  }
  console.log(paint('33;1', "  ▶ Worker B's whole prompt, shown below, is on your clipboard. In the Claude Desktop session that has the"));
  console.log(paint('33;1', '    escrow-worker-b tools, press Ctrl+V and send. Worker B then keeps calling list_open_tasks while it waits.\n'));
  console.log(paint('2', readFileSync('clients/worker-b.md', 'utf8').trim().replace(/^/gm, '    ')));
  console.log(paint('33;1', '\n    Press Enter here once it is sent.'));
  if (!process.stdin.isTTY) return;
  const rl = createPrompt({ input: process.stdin, output: process.stdout });
  await rl.question('');
  rl.close();
}

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

const startWorkerA = () => attach('worker-a', '32', node(['--import', 'tsx', 'clients/worker-a.ts', '--once']));
const startMallory = () =>
  attach(
    mallory,
    '35',
    node(['--import', 'tsx', 'clients/worker-a.ts', '--as', mallory, '--price', '55', '--eta', '30', '--garbage', '--once'], { ESCROW_AGENT_TOKEN: malloryToken }),
  );

// Without worker B the scripted workers are up before the task exists. With it, they wait until Claude Desktop
// has bid, so worker B's bid is first on screen and the poster, which waits for 3 bids, can't move on without it.
let workers: Promise<unknown> = Promise.resolve();
if (!withWorkerB) {
  workers = Promise.all([startWorkerA(), startMallory()]);
  await new Promise((r) => setTimeout(r, 4000)); // let both workers connect before the task exists
}
const posterProcess = node(['scripts/run-poster.mjs', '--stream'], withWorkerB ? { POSTER_MIN_BIDS: '3' } : {});
const poster = attach('poster', '36', posterProcess, /^\[poster\] /);
if (withWorkerB) {
  workers = cueWorkerB(posterProcess).then(() => Promise.all([startWorkerA(), startMallory()]));
}

/** Once the task is open, wait for Claude Desktop's bid (45 seconds at most), then return. */
function cueWorkerB(child: ChildProcess) {
  return new Promise<void>((done) => {
    // Listen alongside the display; never close this reader, because closing it pauses the shared stdout stream.
    let cued = false;
    createInterface({ input: child.stdout! }).on('line', async (line) => {
      const taskId = /"task_id":"(t_[0-9a-z]+)","status":"open"/.exec(line)?.[1];
      if (!taskId || cued) return;
      cued = true;
      console.log(`${clock()} ${paint('34', 'worker-b'.padStart(13))}  task ${taskId} is open; waiting for worker B's bid from Claude Desktop`);
      const watch = await openDb();
      let bid: { price: number; eta_seconds: number } | undefined;
      for (let i = 0; i < 23 && !bid; i++) {
        [bid] = await watch.query<{ price: number; eta_seconds: number }>("SELECT price, eta_seconds FROM bids WHERE task_id = $1 AND worker_id = 'worker-b'", [taskId]);
        if (!bid) await new Promise((r) => setTimeout(r, 2000));
      }
      await watch.close();
      console.log(
        bid
          ? `${clock()} ${paint('34', 'worker-b'.padStart(13))}  bid ${bid.price}¢, eta ${bid.eta_seconds}s (from Claude Desktop) · starting the other workers`
          : paint('33', `${clock()} no bid from Claude Desktop after 45 seconds; starting the other workers anyway`),
      );
      done();
    });
  });
}

const posterExit = await poster;
await Promise.race([workers, new Promise((r) => setTimeout(r, 15_000))]);
for (const c of children) if (c.exitCode === null) c.kill();

// Settlement, straight from the database: every escrow hold on the task this run posted (30s of slack for clock skew).
const summary = await openDb();
const [task] = await summary.query<{ id: string; status: string }>(
  "SELECT id, status FROM tasks WHERE poster_id = 'poster' AND created_at >= $1 ORDER BY created_at DESC LIMIT 1",
  [started - 30_000],
);
if (!task) console.log(paint('31', '\nThe poster did not post a task in this run; see its output above.'));
if (task) {
  console.log(paint('1', `\nSettlement for ${task.id} (${task.status})`));
  const attempts = await summary.query<{ worker_id: string; amount: number; outcome: string; escrow: string; payment_intent: string; reason: string | null }>(
    'SELECT worker_id, amount, outcome, escrow, payment_intent, reason FROM attempts WHERE task_id = $1 ORDER BY created_at',
    [task.id],
  );
  const dashboard = await stripeDashboardBase();
  for (const a of attempts) {
    const verdict = a.outcome === 'passed' ? paint('32', 'PASS') : paint('31', a.outcome.toUpperCase());
    console.log(`  ${a.worker_id.padEnd(13)} ${usd(a.amount).padStart(6)}  ${verdict}  escrow ${a.escrow.padEnd(9)} ${dashboard}/payments/${a.payment_intent}`);
    if (a.reason) console.log(paint('2', `  ${''.padEnd(13)} ${a.reason}`));
  }
}
await summary.close();
console.log(paint('2', `\nDone in ${Math.round((Date.now() - started) / 1000)}s.`));
process.exit(posterExit);
