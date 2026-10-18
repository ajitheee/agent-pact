// `npm run dataset`: the pact's memory as a dataset. Every task the poster ran, with its bids, holds, verdicts
// and the monitor's audit, written to dataset/runs.jsonl (one task per line) and dataset/SUMMARY.md.
// `npm run dataset -- --audit-missing` audits any task that has no saved audit first.
import { mkdirSync, writeFileSync } from 'node:fs';
import { scenarioOf } from '../clients/scenarios.js';
import { auditTask, recalledAudit, type Audit } from '../src/audit.js';
import { openDb, type AttemptRow, type TaskRow } from '../src/db.js';
import { usd } from '../src/market.js';

const db = await openDb();
try {
  const tasks = await db.query<TaskRow>("SELECT * FROM tasks WHERE poster_id = 'poster' ORDER BY created_at");
  const runs = [];
  for (const t of tasks) {
    const bids = await db.query<{ worker_id: string; price: number; eta_seconds: number; status: string; created_at: number }>(
      'SELECT worker_id, price, eta_seconds, status, created_at FROM bids WHERE task_id = $1 ORDER BY created_at',
      [t.id],
    );
    const attempts = await db.query<AttemptRow>('SELECT * FROM attempts WHERE task_id = $1 ORDER BY created_at', [t.id]);
    let audit: Audit | undefined = await recalledAudit(db, t.id);
    if (!audit && process.argv.includes('--audit-missing') && attempts.length) audit = await auditTask(db, t.id);
    const verifier = JSON.parse(t.verifier);
    runs.push({
      task_id: t.id,
      posted_at: new Date(t.created_at).toISOString(),
      scenario: scenarioOf(verifier) ?? null,
      spec: t.spec.split('\n')[0],
      capability: t.capability,
      verifier_type: t.verifier_type,
      budget_cents: t.budget_max,
      deadline_seconds: Math.round((t.deadline_at - t.created_at) / 1000),
      status: t.status,
      bids: bids.map((b) => ({
        worker: b.worker_id,
        price_cents: b.price,
        eta_seconds: b.eta_seconds,
        fits_deadline: b.eta_seconds <= (t.deadline_at - b.created_at) / 1000,
        status: b.status,
      })),
      attempts: attempts.map((a) => ({
        worker: a.worker_id,
        amount_cents: a.amount,
        outcome: a.outcome,
        escrow: a.escrow,
        payment_intent: a.payment_intent,
        reason: a.reason,
        seconds_to_verdict: a.resolved_at ? Math.round((a.resolved_at - a.created_at) / 1000) : null,
      })),
      audit: audit ? { verdict: audit.verdict, checks: audit.checks, flags: audit.flags } : null,
    });
  }

  mkdirSync('dataset', { recursive: true });
  writeFileSync('dataset/runs.jsonl', runs.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Summary: what moved, what the checks decided, what the monitor caught.
  const all = runs.flatMap((r) => r.attempts);
  const captured = all.filter((a) => a.escrow === 'captured');
  const released = all.filter((a) => a.escrow === 'released');
  const flags = runs.flatMap((r) => r.audit?.flags ?? []);
  const cheats = flags.filter((f) => f.kind === 'cheat');
  const count = <T,>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>());
  const records = await db.query<{ worker_id: string; passed: number; total: number }>(
    "SELECT worker_id, COUNT(*) FILTER (WHERE outcome = 'passed')::int AS passed, COUNT(*)::int AS total FROM attempts WHERE outcome IN ('passed', 'failed', 'timed_out') GROUP BY worker_id ORDER BY total DESC, worker_id",
  );
  const watch = await db.query<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'watch:%' ORDER BY key");

  const md = [
    '# Agent Task Escrow: run dataset',
    '',
    `Generated ${new Date().toISOString()} from the production database by \`npm run dataset\`. One task per line in`,
    '[runs.jsonl](runs.jsonl): bids, escrow holds, verdicts and the monitor\'s audit. Stripe is in test mode.',
    '',
    '## Totals',
    '',
    `- **${runs.length} tasks** posted: ${runs.filter((r) => r.status === 'completed').length} completed, ${runs.filter((r) => r.status === 'expired').length} expired.`,
    `- **${all.length} escrow holds**: ${captured.length} captured (${usd(captured.reduce((s, a) => s + a.amount_cents, 0))} paid for work that passed), ${released.length} released (${usd(released.reduce((s, a) => s + a.amount_cents, 0))} never paid for work that failed).`,
    `- **${runs.filter((r) => r.audit).length} audited** by the monitor: ${[...count(runs.filter((r) => r.audit), (r) => r.audit!.verdict)].map(([v, n]) => `${n} ${v}`).join(', ') || 'none yet'}.`,
    `- **${cheats.length} cheat flags**: ${[...count(cheats, (f) => f.label)].map(([l, n]) => `${l} ×${n}`).join(', ') || 'none'}.`,
    '',
    '## Runs by scenario',
    '',
    '| Posted (UTC) | Scenario | Task | Status | Paid | Released | Monitor | Flags |',
    '|---|---|---|---|---|---|---|---|',
    ...runs
      .filter((r) => r.attempts.length)
      .map((r) => {
        const paid = r.attempts.filter((a) => a.escrow === 'captured').map((a) => `${a.worker} ${usd(a.amount_cents)}`).join(', ') || '-';
        const back = r.attempts.filter((a) => a.escrow === 'released').map((a) => `${a.worker} ${usd(a.amount_cents)}`).join(', ') || '-';
        const f = (r.audit?.flags ?? []).filter((x) => x.kind === 'cheat').map((x) => `${x.worker}: ${x.label}`).join('; ') || '-';
        return `| ${r.posted_at.slice(0, 16).replace('T', ' ')} | ${r.scenario ?? 'earlier'} | ${r.task_id} | ${r.status} | ${paid} | ${back} | ${r.audit?.verdict ?? 'not audited'} | ${f} |`;
      }),
    '',
    '## Worker records (the reputation every poster sees)',
    '',
    '| Worker | Passed / delivered |',
    '|---|---|',
    ...records.map((r) => `| ${r.worker_id} | ${r.passed}/${r.total} |`),
    '',
    '## Watchlist (workers the monitor caught cheating)',
    '',
    ...(watch.length
      ? watch.map(({ key, value }) => `- **${key.slice(6)}**: ${(JSON.parse(value) as { task_id: string; label: string }[]).map((e) => `${e.label} on ${e.task_id}`).join('; ')}`)
      : ['- nobody yet']),
    '',
  ].join('\n');
  writeFileSync('dataset/SUMMARY.md', md);
  console.log(`dataset: ${runs.length} tasks → dataset/runs.jsonl and dataset/SUMMARY.md (${runs.filter((r) => r.audit).length} audited, ${cheats.length} cheat flags)`);
} finally {
  await db.close();
}
