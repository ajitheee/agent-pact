import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { openDb, type Db } from '../src/db.js';
import { AgentError } from '../src/errors.js';
import { Market } from '../src/market.js';
import { FakeRail } from '../src/rails.js';
import { Verifiers } from '../src/verifier/index.js';

const EMAILS_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'array',
    minItems: 3,
    maxItems: 3,
    items: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
  },
};
const GOOD = [{ email: 'a@acme.dev' }, { email: 'b@acme.dev' }, { email: 'c@acme.dev' }];

async function rejects(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AgentError, `expected AgentError, got ${e}`);
    assert.equal(e.code, code);
    return e.toJSON();
  }
  assert.fail(`expected ${code}`);
}

describe('market', () => {
  let clock: number;
  let rail: FakeRail;
  let db: Db;
  let market: Market;

  beforeEach(async () => {
    clock = Date.parse('2026-10-17T18:00:00Z');
    rail = new FakeRail();
    db = await openDb({ url: null, dir: null }); // in-memory PGlite, never the real DATABASE_URL
    market = new Market({ db, rail, verifiers: new Verifiers(), now: () => clock });
  });
  afterEach(() => db.close());

  const post = (over: Record<string, unknown> = {}) =>
    market.postTask('poster', { spec: 'three emails', verifier: EMAILS_SCHEMA, budget_max: 200, deadline: 600, capability: 'data.emails', ...over });

  it('rejects an over-budget bid with the v2 error shape', async () => {
    const { task_id } = await post();
    const err = await rejects(market.bid('w1', { task_id, price: 350, eta_seconds: 60 }), 'bid_over_budget');
    assert.deepEqual(err, { error_code: 'bid_over_budget', budget_max: 200, your_bid: 350, fix: 'bid <= 200' });
  });

  it('suggests cents when an agent bids in dollars', async () => {
    const { task_id } = await post();
    const err = await rejects(market.bid('w1', { task_id, price: 1.5, eta_seconds: 60 }), 'amount_must_be_cents');
    assert.equal(err.did_you_mean, 150);
  });

  it('happy path: hold on accept, capture on pass, reputation 1/1', async () => {
    const { task_id } = await post();
    const { bid_id } = await market.bid('w1', { task_id, price: 150, eta_seconds: 60 });
    const accepted = await market.acceptBid('poster', { task_id, bid_id });
    assert.equal(rail.intents.get(accepted.escrow.payment_intent)?.status, 'requires_capture');

    const result = await market.submitWork('w1', { task_id, payload: GOOD });
    assert.equal(result.verdict, 'pass');
    assert.equal(rail.intents.get(accepted.escrow.payment_intent)?.status, 'succeeded');
    assert.deepEqual(await market.reputation(db, 'w1'), { reputation: 1, record: '1/1' });

    const task = await market.getTask('poster', { task_id });
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.deliverable, GOOD);
    assert.equal((await market.getTask('w2', { task_id })).deliverable, undefined, 'only the poster sees the deliverable');
  });

  it('failure path: release, reputation drop, task reopens, no rebid', async () => {
    const { task_id } = await post();
    const cheat = await market.bid('mallory', { task_id, price: 60, eta_seconds: 10 });
    await market.bid('w1', { task_id, price: 150, eta_seconds: 60 });
    const accepted = await market.acceptBid('poster', { task_id, bid_id: cheat.bid_id });

    const result = await market.submitWork('mallory', { task_id, payload: '[{"email":"lol"}]' });
    assert.equal(result.verdict, 'fail');
    assert.equal(result.task_status, 'open');
    assert.equal(rail.intents.get(accepted.escrow.payment_intent)?.status, 'canceled');
    assert.deepEqual(await market.reputation(db, 'mallory'), { reputation: 0, record: '0/1' });
    await rejects(market.bid('mallory', { task_id, price: 55, eta_seconds: 10 }), 'already_failed_this_task');

    const bids = await market.listBids('poster', { task_id, min_reputation: 0.5 });
    assert.equal(bids.filtered_out, 1);
    assert.deepEqual(bids.bids.map((b) => b.worker), ['w1']);
  });

  it('deadline: sweep releases a held escrow and counts a miss', async () => {
    const { task_id } = await post({ deadline: 60 });
    const { bid_id } = await market.bid('w1', { task_id, price: 100, eta_seconds: 30 });
    const accepted = await market.acceptBid('poster', { task_id, bid_id });
    clock += 61_000;
    await market.sweep();
    assert.equal((await market.getTask('poster', { task_id })).status, 'expired');
    assert.equal(rail.intents.get(accepted.escrow.payment_intent)?.status, 'canceled');
    assert.deepEqual(await market.reputation(db, 'w1'), { reputation: 0, record: '0/1' });
    await rejects(market.submitWork('w1', { task_id, payload: GOOD }), 'task_not_awarded');
  });

  it('since cursor returns deltas and flags your award', async () => {
    const { task_id } = await post();
    const first = await market.listOpenTasks('w1', { capability: 'data' });
    assert.equal(first.tasks.length, 1);
    const { bid_id } = await market.bid('w1', { task_id, price: 100, eta_seconds: 30 });
    await market.acceptBid('poster', { task_id, bid_id });
    const delta = await market.listOpenTasks('w1', { since: first.cursor });
    assert.deepEqual(delta.tasks, []);
    assert.deepEqual(delta.closed, [{ task_id, status: 'awarded', awarded_to_you: true }]);
  });

  it('python verifier: assertion message becomes the fail reason', async () => {
    const { task_id } = await post({
      verifier: { type: 'python', code: 'def verify(rows):\n    assert len({r["email"].split("@")[1] for r in rows}) == len(rows), "domains must be distinct"' },
    });
    const { bid_id } = await market.bid('w1', { task_id, price: 100, eta_seconds: 30 });
    await market.acceptBid('poster', { task_id, bid_id });
    const result = await market.submitWork('w1', { task_id, payload: GOOD });
    assert.equal(result.verdict, 'fail');
    assert.deepEqual(result.reasons, ['domains must be distinct']);
  });

  it('only the awarded worker can submit, and only the poster can accept', async () => {
    const { task_id } = await post();
    const { bid_id } = await market.bid('w1', { task_id, price: 100, eta_seconds: 30 });
    await rejects(market.acceptBid('w1', { task_id, bid_id }), 'not_your_task');
    await market.acceptBid('poster', { task_id, bid_id });
    await rejects(market.submitWork('w2', { task_id, payload: GOOD }), 'not_awarded_to_you');
  });

  it('settles exactly once when a submit races the deadline sweep', async () => {
    const { task_id } = await post({ deadline: 60 });
    const { bid_id } = await market.bid('w1', { task_id, price: 100, eta_seconds: 30 });
    const accepted = await market.acceptBid('poster', { task_id, bid_id });
    const submit = market.submitWork('w1', { task_id, payload: GOOD });
    clock += 61_000; // deadline passes while the verifier runs
    const sweep = market.sweep();
    const [outcome] = await Promise.allSettled([submit, sweep]);
    const intent = rail.intents.get(accepted.escrow.payment_intent)!;
    const task = await market.getTask('poster', { task_id });
    // Either the delivery won the row lock (captured, completed) or the sweep did (released, expired) — never both.
    if (outcome.status === 'fulfilled') {
      assert.deepEqual([intent.status, task.status], ['succeeded', 'completed']);
    } else {
      assert.deepEqual([intent.status, task.status], ['canceled', 'expired']);
    }
  });
});
