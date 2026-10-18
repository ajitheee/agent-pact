// `npm run live`: the whole demo in one terminal, against the server in clients/tokens.local.json
// (production after `npm run setup:clients -- --url …`). For rehearsals and the backup video.
//
//   worker-a        mcp-use client, honest: bids about 60% of the budget / 90s, delivers work that passes the check
//   mallory-xxxx    mcp-use client, cheapest: bids about 20% of the budget / 30s, delivers work that fails it. A fresh identity each
//                   run, so every take shows "new agent gets a shot, fails, refunded" instead of a known bad actor.
//   poster          Claude Code: posts the task, picks the cheapest bid that fits the deadline (Mallory), sees
//                   her fail and get refunded, filters by reputation, re-awards to worker A, who gets paid.
//
//   npm run live -- --scenario sql-report  picks the task from clients/scenarios/ (ci-fix, sql-report, invoices);
//                   Mallory fails a different way in each. Default: ci-fix. The run ends with the output the poster got.
//
//   npm run live -- --with-worker-b   adds the third client: worker B in Claude Desktop (escrow-worker-b server).
//                   Its prompt goes on the clipboard. Paste and send it before the poster starts: worker B
//                   long-polls list_open_tasks, so it bids as soon as the task exists. The poster waits for
//                   3 bids, and worker B's 80¢ / 300s bid loses on the 240s deadline.
//
// The screen is a presenter view: one line per market event (posted, bids, Stripe holds, verdicts), read from the
// escrow's own event log, plus the poster's one-line decisions. --verbose shows every tool call and worker log instead.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createInterface as createPrompt } from 'node:readline/promises';
import { mintToken } from '../src/agents.js';
import { config } from '../src/config.js';
import { openDb, type EventRow } from '../src/db.js';
import { newId } from '../src/ids.js';
import { usd } from '../src/market.js';
import { stripeDashboardBase } from '../src/rails.js';
import { loadScenario } from '../clients/scenarios.js';
import { auditTask, formatAudit } from '../src/audit.js';

const tokens = JSON.parse(readFileSync('clients/tokens.local.json', 'utf8')) as Record<string, string>;
const withWorkerB = process.argv.includes('--with-worker-b');
const verbose = process.argv.includes('--verbose');
const flag = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const scenario = loadScenario(flag('--scenario') ?? 'ci-fix');
/** The task this run's poster posted, read from its post_task result, so back-to-back runs never mix up tasks. */
const runTask: { id?: string } = {};
const paint = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const started = Date.now();
const clock = () => paint('2', `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`);
/** One presenter line: a bold event label, then the text. Continuation lines indent under the text. */
const say = (kind: string, color: string, text: string) => console.log(`${clock()}  ${paint(`${color};1`, kind.padEnd(7))}  ${text}`);
const INDENT = ' '.repeat(16);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Word-wrap to lines of at most `width`, keeping at most `max` lines (the last one clipped). */
function wrap(s: string, width: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of s.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length > max ? [...lines.slice(0, max - 1), clip(lines.slice(max - 1).join(' '), width)] : lines;
}

// A fresh Mallory, registered straight in the shared database.
const db = await openDb();
const mallory = newId('mallory', 4).replace('_', '-');
const domain = config.escrowEmail.split('@')[1];
const malloryToken = await mintToken(db, mallory, domain ? { email: `${mallory}@${domain}` } : {});
await db.close();

console.log(paint('1', `\nAgent Task Escrow · live run against ${tokens.url}`));
console.log(
  paint('2', `poster = Claude Code · worker-a = mcp-use client · ${mallory} = mcp-use client (fresh, cheapest, junk)${withWorkerB ? ' · worker-b = Claude Desktop' : ''}`),
);
console.log(paint('2', `scenario ${scenario.order}: ${scenario.title} (${scenario.kind}) · ${scenario.strength}\n`));
if (!verbose) console.log(paint('2', 'presenter view: one line per market event. Add --verbose to see every tool call.\n'));
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

/** What a child's output line becomes on screen: the text to print under its label, or null to hide it. */
type View = (text: string) => string | null;

const children: ChildProcess[] = [];
function attach(name: string, color: string, child: ChildProcess, strip = /^\d\d:\d\d:\d\d \[[^\]]+\] /, view: View = (t) => t) {
  children.push(child);
  const label = paint(color, name.padStart(13));
  for (const stream of [child.stdout!, child.stderr!]) {
    createInterface({ input: stream }).on('line', (line) => {
      const text = view(line.replace(strip, ''));
      if (text?.trim() && !text.startsWith('>')) console.log(`${clock()} ${label}  ${text}`);
    });
  }
  return new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

// Presenter view: the event log tells the story, so worker logs show only trouble.
const workerView: View = (text) => (verbose || /connect attempt|submit failed|skipped|retrying/.test(text) ? text : null);

/** Presenter view of the poster: only its short decision lines, not tool calls or the closing summary. */
function posterView(): View {
  let summary = false;
  const read = new Set<string>();
  return (text) => {
    runTask.id ??= /"task_id":"(t_[0-9a-z]+)","status":"open"/.exec(text)?.[1];
    if (verbose) return text;
    // Before the task is posted the poster reads the ticket and its check, then writes the job post: show that,
    // so the screen isn't still for the 30-50 seconds it takes.
    const file = /^→ Read (\S+)/.exec(text)?.[1];
    if (file && !runTask.id) {
      const what = /spec\.txt$/.test(file) ? 'the ticket' : /verify\.py$|schema\.json$/.test(file) ? 'its acceptance check' : 'a file';
      say('POSTER', '36', paint('2', `reading ${what} (${file.split('/').pop()})`));
      read.add(what);
      if (read.has('the ticket') && read.has('its acceptance check')) say('POSTER', '36', paint('2', 'writing the job post: the task, budget, deadline and the check that decides payment…'));
      return null;
    }
    if (!text.trim()) summary = true; // the closing summary follows a blank line; the settlement table covers it
    else if (!summary && /^  \S/.test(text)) say('POSTER', '36', `"${clip(text.trim(), 150)}"`);
    return null;
  };
}

const startWorkerA = () =>
  attach('worker-a', '32', node(['--import', 'tsx', 'clients/worker-a.ts', '--price', String(scenario.prices['worker-a']), '--once']), undefined, workerView);
const startMallory = () =>
  attach(
    mallory,
    '35',
    node(['--import', 'tsx', 'clients/worker-a.ts', '--as', mallory, '--price', String(scenario.prices.mallory), '--eta', '30', '--garbage', '--once'], { ESCROW_AGENT_TOKEN: malloryToken }),
    undefined,
    workerView,
  );

// Without worker B the scripted workers are up before the task exists. With it, they wait until Claude Desktop
// has bid, so worker B's bid is first on screen and the poster, which waits for 3 bids, can't move on without it.
let workers: Promise<unknown> = Promise.resolve();
if (!withWorkerB) {
  workers = Promise.all([startWorkerA(), startMallory()]);
  await new Promise((r) => setTimeout(r, 4000)); // let both workers connect before the task exists
}
const posterProcess = node(['scripts/run-poster.mjs', '--stream'], { POSTER_SCENARIO: scenario.name, ...(withWorkerB ? { POSTER_MIN_BIDS: '3' } : {}) });
const poster = attach('poster', '36', posterProcess, /^\[poster\] /, posterView());
if (withWorkerB) {
  workers = cueWorkerB(posterProcess).then(() => Promise.all([startWorkerA(), startMallory()]));
}
const watching = { on: !verbose };
const events = watching.on ? watchEvents() : Promise.resolve();

/** Presenter view: the escrow's own event log for the task this run posts, one line per step. */
async function watchEvents() {
  const watch = await openDb();
  let task: { id: string; spec: string; deadline_at: number } | undefined;
  let after = 0;
  for (;;) {
    // Decide before reading, so the events written just before the poster exits still show.
    const last = !watching.on;
    if (!task && runTask.id) {
      [task] = await watch.query<{ id: string; spec: string; deadline_at: number }>('SELECT id, spec, deadline_at FROM tasks WHERE id = $1', [runTask.id]);
    }
    if (task) {
      for (const e of await watch.query<EventRow>('SELECT * FROM events WHERE task_id = $1 AND seq > $2 ORDER BY seq', [task.id, after])) {
        after = e.seq;
        showEvent(task, e);
      }
    }
    if (last) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await watch.close();
}

function showEvent(task: { spec: string; deadline_at: number }, e: EventRow) {
  const d = JSON.parse(e.data) as Record<string, any>;
  const client = (w: string) => (w === 'worker-b' ? 'Claude Desktop' : w.startsWith('mallory') ? 'mcp-use client, new' : 'mcp-use client');
  // Python checks run in a sandbox; a JSON Schema check runs no code, so the escrow server validates it directly.
  const where = (s?: string) => (s === 'blaxel' ? 'in Blaxel' : s === 'local' ? 'in the local sandbox' : 'by the escrow server');
  const left = Math.round((task.deadline_at - e.at) / 1000);
  switch (e.type) {
    case 'posted':
      say('POSTED', '36', `${usd(d.budget_max)} budget · ${left}s deadline · ${d.verifier_type === 'python' ? 'Python check, run in a sandbox' : 'JSON Schema check'}`);
      return console.log(INDENT + paint('2', `"${clip(task.spec, 110)}"`));
    case 'bid':
    case 'rebid': {
      const late = d.eta_seconds > left ? paint('31', `   ✗ misses the deadline (${left}s left)`) : '';
      return say('BID', '34', `${e.actor.padEnd(13)} ${client(e.actor).padEnd(20)} ${usd(d.price).padStart(6)}  ETA ${d.eta_seconds}s${late}`);
    }
    case 'awarded':
      return say('HELD', '33', `${usd(d.price)} held on Stripe for ${d.worker} · authorized, not moved`);
    case 'failed':
      // Wrapped, not clipped: the end of a reason is often the useful part ("…matches a known mistake: …").
      const [first, ...rest] = wrap(`${e.actor}: ${d.reason}`, 110, 3);
      say('FAIL', '31', first);
      for (const line of rest) console.log(INDENT + line);
      return console.log(INDENT + paint('2', `checked ${where(d.sandbox)} · hold released, the poster pays nothing`));
    case 'passed':
      return say('PASS', '32', `${e.actor}: passed · checked ${where(d.sandbox)} · ${usd(d.amount)} captured`);
    case 'timed_out':
      return say('LATE', '31', `${d.worker} missed the deadline · hold released`);
    case 'expired':
      return say('EXPIRED', '31', 'the deadline passed without a passing delivery · nothing paid');
  }
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
      if (verbose) console.log(`${clock()} ${paint('34', 'worker-b'.padStart(13))}  task ${taskId} is open; waiting for worker B's bid from Claude Desktop`);
      const watch = await openDb();
      let bid: { price: number; eta_seconds: number } | undefined;
      for (let i = 0; i < 23 && !bid; i++) {
        [bid] = await watch.query<{ price: number; eta_seconds: number }>("SELECT price, eta_seconds FROM bids WHERE task_id = $1 AND worker_id = 'worker-b'", [taskId]);
        if (!bid) await new Promise((r) => setTimeout(r, 2000));
      }
      await watch.close();
      if (!bid) console.log(paint('33', `${clock()} no bid from Claude Desktop after 45 seconds; starting the other workers anyway`));
      else if (verbose) console.log(`${clock()} ${paint('34', 'worker-b'.padStart(13))}  bid ${bid.price}¢, eta ${bid.eta_seconds}s (from Claude Desktop) · starting the other workers`);
      done();
    });
  });
}

const posterExit = await poster;
await Promise.race([workers, new Promise((r) => setTimeout(r, 15_000))]);
for (const c of children) if (c.exitCode === null) c.kill();
watching.on = false;
await events;

// Settlement, straight from the database: every escrow hold on the task this run posted.
const summary = await openDb();
const [task] = runTask.id ? await summary.query<{ id: string; status: string }>('SELECT id, status FROM tasks WHERE id = $1', [runTask.id]) : [];
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
    if (a.reason) for (const line of wrap(a.reason, 120, 2)) console.log(paint('2', `  ${''.padEnd(13)} ${line}`));
  }
  // What the poster paid for: the scenario's show.py renders the delivery that passed (a diff, a report, a ledger).
  const [delivered] = await summary.query<{ worker_id: string; payload: string }>(
    "SELECT worker_id, payload FROM attempts WHERE task_id = $1 AND outcome = 'passed'",
    [task.id],
  );
  const show = `clients/scenarios/${scenario.name}/show.py`;
  if (delivered && existsSync(show)) {
    const out = spawnSync(config.pythonBin, ['-I', '-X', 'utf8', show], { input: delivered.payload, encoding: 'utf8', timeout: 20_000 });
    console.log(paint('1', `\nOutput delivered to the poster by ${delivered.worker_id}`));
    for (const line of (out.stdout || out.stderr || 'could not render the output').trimEnd().split('\n')) {
      const color = /^[+](?![+])/.test(line) ? '32' : /^-(?!-)/.test(line) ? '31' : '';
      console.log(`  ${color ? paint(color, line) : line}`);
    }
  }
  // The monitor: an independent audit of the steps, the money and every delivery, saved in the pact's memory.
  console.log('');
  try {
    for (const line of formatAudit(await auditTask(summary, task.id), paint)) console.log(line);
  } catch (e) {
    console.log(paint('33', `Monitor audit could not finish: ${(e as Error).message}. Run npm run audit -- ${task.id}`));
  }
}
await summary.close();
// npm run rehearse reads which task this run posted from here.
if (process.env.LIVE_TASK_FILE && task) writeFileSync(process.env.LIVE_TASK_FILE, task.id);
console.log(paint('2', `\nDone in ${Math.round((Date.now() - started) / 1000)}s.`));
process.exit(posterExit);
