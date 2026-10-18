import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadScenario } from '../clients/scenarios.js';
import { auditTask, recalledAudit } from '../src/audit.js';
import { openDb, type Db } from '../src/db.js';
import { Market } from '../src/market.js';
import { FakeRail } from '../src/rails.js';
import { Verifiers } from '../src/verifier/index.js';

// The monitor, on real market runs of the bug-fix scenario: Mallory's lookup table must be flagged as
// memorized, a second identity delivering the same file as the same operator, and a tampered escrow as broken.
describe('monitor audit', () => {
  const bugfix = loadScenario('bugfix');
  let clock: number;
  let db: Db;
  let market: Market;
  const verifiers = new Verifiers();

  beforeEach(async () => {
    clock = Date.parse('2026-10-17T18:00:00Z');
    db = await openDb({ url: null, dir: null }); // in-memory PGlite
    market = new Market({ db, rail: new FakeRail(), verifiers, now: () => clock });
  });
  afterEach(() => db.close());

  /** Mallory bids cheapest, wins, delivers her bad file and fails; worker A is hired next and passes. */
  async function run(mallory: string) {
    const { task_id } = await market.postTask('poster', { spec: bugfix.spec, verifier: bugfix.verifier, budget_max: 200, deadline: 240, capability: bugfix.capability });
    const cheap = await market.bid(mallory, { task_id, price: 55, eta_seconds: 30 });
    const honest = await market.bid('worker-a', { task_id, price: 150, eta_seconds: 90 });
    await market.acceptBid('poster', { task_id, bid_id: cheap.bid_id });
    clock += 2000;
    await market.submitWork(mallory, { task_id, payload: bugfix.bad });
    await market.acceptBid('poster', { task_id, bid_id: honest.bid_id });
    clock += 2000;
    await market.submitWork('worker-a', { task_id, payload: bugfix.good });
    clock += 60_000;
    return task_id;
  }

  it('passes the steps and money, flags the memorized answers, and remembers the audit', async () => {
    const taskId = await run('mallory-1');
    const audit = await auditTask(db, taskId, { verifiers });
    assert.equal(audit.verdict, 'flagged');
    assert.deepEqual(audit.checks.map((c) => [c.name, c.ok]), [['steps in order', true], ['escrow = verdicts', true], ['re-checked', true]]);
    assert.match(audit.checks[0].detail, /posted → 2 bids → award mallory-1 → fail → award worker-a → pass → completed/);
    assert.ok(audit.flags.some((f) => f.worker === 'mallory-1' && f.kind === 'cheat' && f.label === 'looks memorized'));
    assert.ok(audit.flags.some((f) => f.worker === 'mallory-1' && f.label === 'new identity'));
    assert.ok(!audit.flags.some((f) => f.worker === 'worker-a' && f.kind !== 'note'));
    assert.deepEqual(audit.records, { 'mallory-1': '0/1', 'worker-a': '1/1' });

    assert.deepEqual(await recalledAudit(db, taskId), audit);
    const [watch] = await db.query<{ value: string }>("SELECT value FROM kv WHERE key = 'watch:mallory-1'");
    assert.equal(JSON.parse(watch.value)[0].label, 'looks memorized');
  });

  it('spots one operator behind two identities: same delivery, new name', async () => {
    await run('mallory-1');
    const second = await run('mallory-2');
    const audit = await auditTask(db, second, { verifiers });
    const twin = audit.flags.find((f) => f.worker === 'mallory-2' && f.label === 'same operator?');
    assert.match(twin?.detail ?? '', /identical to mallory-1's on t_/);
    // worker A delivering its own file again is not a twin.
    assert.ok(!audit.flags.some((f) => f.worker === 'worker-a' && f.label === 'same operator?'));
  });

  it('calls the task broken when the escrow does not match the verdict', async () => {
    const taskId = await run('mallory-1');
    await db.query("UPDATE attempts SET escrow = 'captured' WHERE worker_id = 'mallory-1'");
    const audit = await auditTask(db, taskId, { verifiers });
    assert.equal(audit.verdict, 'broken');
    assert.match(audit.checks.find((c) => c.name === 'escrow = verdicts')!.detail, /mallory-1: failed but escrow captured/);
  });
});
