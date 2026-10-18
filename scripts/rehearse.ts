// `npm run rehearse`: every demo scenario end to end against production, one after another, before going on stage.
// Each run is the real thing: the Claude Code poster, worker A, a fresh Mallory, Stripe holds, the check in Blaxel,
// the email thread and the monitor's audit. Then a summary table, and the dataset is refreshed (npm run dataset).
//   npm run rehearse                    all scenarios (about 6 minutes)
//   npm run rehearse -- sql-report      just these
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScenario, malloryUndercuts, scenarioNames } from '../clients/scenarios.js';
import { recalledAudit } from '../src/audit.js';
import { openDb } from '../src/db.js';
import { usd } from '../src/market.js';

const paint = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const chosen = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const names = chosen.length ? chosen : scenarioNames();
for (const n of names) loadScenario(n); // fail fast on a typo
const tsx = (script: string, args: string[] = [], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--env-file-if-exists=.env', '--disable-warning=ExperimentalWarning', '--import', 'tsx', script, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

const results: { name: string; taskId?: string; seconds: number; exit: number | null }[] = [];
for (const [i, name] of names.entries()) {
  console.log(paint('1;36', `\n━━━ Rehearsal ${i + 1}/${names.length}: ${loadScenario(name).title} ━━━`));
  const started = Date.now();
  // live.ts writes the id of the task it posted here, so the summary never confuses back-to-back runs.
  const taskFile = join(tmpdir(), `escrow-rehearse-${process.pid}-${name}.txt`);
  const run = tsx('scripts/live.ts', ['--scenario', name], { LIVE_TASK_FILE: taskFile });
  const taskId = existsSync(taskFile) ? readFileSync(taskFile, 'utf8').trim() : undefined;
  rmSync(taskFile, { force: true });
  results.push({ name, taskId, seconds: Math.round((Date.now() - started) / 1000), exit: run.status });
}

const db = await openDb();
console.log(paint('1', `\nRehearsal summary: ${names.length} scenario${names.length === 1 ? '' : 's'}\n`));
console.log(paint('2', `  ${'scenario'.padEnd(12)} ${'task'.padEnd(12)} ${'status'.padEnd(10)} ${'Mallory'.padEnd(20)} ${'worker A'.padEnd(16)} ${'monitor'.padEnd(9)} time`));
let problems = 0;
for (const r of results) {
  const [task] = r.taskId ? await db.query<{ id: string; status: string }>('SELECT id, status FROM tasks WHERE id = $1', [r.taskId]) : [];
  const attempts = task
    ? await db.query<{ worker_id: string; outcome: string; escrow: string; amount: number }>('SELECT worker_id, outcome, escrow, amount FROM attempts WHERE task_id = $1 ORDER BY created_at', [task.id])
    : [];
  const mallory = attempts.find((a) => a.worker_id.startsWith('mallory'));
  const workerA = attempts.find((a) => a.worker_id === 'worker-a');
  const audit = task ? await recalledAudit(db, task.id) : undefined;
  // Where Mallory undercuts, she is hired first and her hold released; elsewhere worker A's lower bid wins outright.
  const undercuts = malloryUndercuts(loadScenario(r.name));
  const malloryAsExpected = undercuts ? mallory?.escrow === 'released' : !mallory;
  const ok = task?.status === 'completed' && malloryAsExpected && workerA?.escrow === 'captured' && audit && audit.verdict !== 'broken';
  if (!ok) problems++;
  console.log(
    `  ${ok ? paint('32', '✓') : paint('31', '✗')} ${r.name.padEnd(10)} ${(task?.id ?? 'no task').padEnd(12)} ${(task?.status ?? '-').padEnd(10)} ` +
      `${(mallory ? `${mallory.outcome}, ${mallory.escrow}` : undercuts ? '-' : 'outbid, never hired').padEnd(20)} ${(workerA ? `${workerA.outcome} ${usd(workerA.amount)}` : '-').padEnd(16)} ` +
      `${(audit?.verdict ?? '-').padEnd(9)} ${r.seconds}s`,
  );
}
await db.close();

console.log('');
tsx('scripts/dataset.ts');
console.log(problems ? paint('31', `\n${problems} scenario${problems > 1 ? 's' : ''} did not finish as expected. Scroll up to its run.\n`) : paint('32', '\nAll scenarios ran clean: ready for the stage.\n'));
process.exit(problems ? 1 : 0);
