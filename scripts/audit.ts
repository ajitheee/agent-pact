// `npm run audit -- [task_id]`: the monitor's audit of one task (default: the poster's latest), re-run now.
// `npm run audit -- --watchlist`: every worker the monitor has caught cheating, from the pact's memory.
import { auditTask, formatAudit } from '../src/audit.js';
import { openDb } from '../src/db.js';

const paint = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const db = await openDb();
try {
  if (process.argv.includes('--watchlist')) {
    const rows = await db.query<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'watch:%' ORDER BY key");
    console.log(paint('1', `\nWatchlist: ${rows.length} worker${rows.length === 1 ? '' : 's'} caught cheating\n`));
    for (const { key, value } of rows) {
      const entries = JSON.parse(value) as { task_id: string; label: string; detail: string }[];
      console.log(`  ${key.slice(6).padEnd(16)} ${entries.map((e) => `${e.label} on ${e.task_id}`).join(' · ')}`);
    }
  } else {
    const id = process.argv.slice(2).find((a) => a.startsWith('t_'));
    const [task] = id
      ? [{ id }]
      : await db.query<{ id: string }>("SELECT id FROM tasks WHERE poster_id = 'poster' ORDER BY created_at DESC LIMIT 1");
    if (!task) throw new Error('no task to audit');
    console.log('');
    for (const line of formatAudit(await auditTask(db, task.id), paint)) console.log(line);
  }
  console.log('');
} finally {
  await db.close();
}
