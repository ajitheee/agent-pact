import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { addAgent } from '../src/agents.js';
import { openDb, type Db } from '../src/db.js';
import { EmailBridge, parseCommand } from '../src/email/bridge.js';
import { FakeMail } from '../src/email/primitive.js';
import { Market } from '../src/market.js';
import { FakeRail } from '../src/rails.js';
import { Verifiers } from '../src/verifier/index.js';

const ESCROW = 'escrow@agents.test';
const at = (name: string) => `${name}@agents.test`;
const SCHEMA = { type: 'json_schema', schema: { type: 'array', minItems: 2, items: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } };

async function until<T>(check: () => Promise<T | undefined | false> | T | undefined | false, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('parseCommand', () => {
  it('reads bids in cents or dollars, with second or minute etas', () => {
    assert.deepEqual(parseCommand('BID 150 90'), { kind: 'bid', price: 150, eta: 90 });
    assert.deepEqual(parseCommand('bid $1.50 2m'), { kind: 'bid', price: 150, eta: 120 });
    assert.deepEqual(parseCommand('Sure.\nbid 80 300s\nthanks'), { kind: 'bid', price: 80, eta: 300 });
  });

  it('reads accept, submit and status', () => {
    assert.deepEqual(parseCommand('ACCEPT b_7hq2m0zx'), { kind: 'accept', bidId: 'b_7hq2m0zx' });
    assert.deepEqual(parseCommand('SUBMIT\n[{"email":"a@b.co"}]'), { kind: 'submit', payload: [{ email: 'a@b.co' }] });
    assert.deepEqual(parseCommand('status'), { kind: 'status' });
  });

  it('ignores commands inside quoted history', () => {
    assert.deepEqual(parseCommand('hello\n\nOn Fri, escrow wrote:\n> BID 150 90'), { error: 'no command' });
    assert.deepEqual(parseCommand('> ACCEPT b_x\nnothing here'), { error: 'no command' });
  });
});

describe('email thread', () => {
  let db: Db;
  let mail: FakeMail;
  let market: Market;
  let bridge: EmailBridge;

  beforeEach(async () => {
    db = await openDb({ url: null, dir: null });
    market = new Market({ db, rail: new FakeRail(), verifiers: new Verifiers() });
    for (const name of ['poster', 'swift', 'mallory']) await addAgent(db, name, { email: at(name) });
    mail = new FakeMail();
    bridge = new EmailBridge({ market, mail, address: ESCROW, pollWaitSeconds: 0.05 }).start();
  });
  afterEach(async () => {
    await bridge.stop();
    await db.close();
  });

  it('runs a task end to end by email: post, reply-bid, reply-accept, reply-submit', async () => {
    const { task_id } = await market.postTask('poster', { spec: 'two emails', verifier: SCHEMA, budget_max: 200, deadline: 600 });
    await bridge.idle();
    const [root] = mail.sent;
    assert.equal(root.to, at('poster'));
    assert.deepEqual(root.cc, [at('swift'), at('mallory')], 'post a task → email to worker agents');
    assert.match(root.subject, new RegExp(`^\\[${task_id}\\] `));
    assert.match(root.text, /BID <price in cents> <eta seconds>/);

    // Reply → bid
    const bidMail = mail.deliver({ from: at('swift'), to: ESCROW, subject: `Re: ${root.subject}`, text: 'BID 150 90\n\nOn Sat, escrow wrote:\n> BID 1 1', inReplyTo: root.id });
    await until(() => mail.repliesTo(bidMail).length);
    assert.match(mail.repliesTo(bidMail)[0], /^OK BID/);
    await bridge.idle();
    const bidNotice = mail.sent.at(-1)!;
    assert.equal(bidNotice.to, at('poster'));
    assert.deepEqual(bidNotice.cc, [], 'bids stay sealed: only the poster hears about them');
    const bidId = /ACCEPT (b_[0-9a-z]+)/.exec(bidNotice.text)![1];

    // cc the winner → award
    const acceptMail = mail.deliver({ from: at('poster'), to: ESCROW, subject: `Re: ${root.subject}`, text: `ACCEPT ${bidId}`, inReplyTo: bidNotice.id });
    await until(() => mail.repliesTo(acceptMail).length);
    await bridge.idle();
    const award = mail.sent.at(-1)!;
    assert.deepEqual(award.cc, [at('swift')]);
    assert.match(award.text, /held, not captured/);

    // Delivery by email → verifier → payment captured, all in the same thread
    const submitMail = mail.deliver({ from: at('swift'), to: ESCROW, subject: `Re: ${root.subject}`, text: 'SUBMIT [{"email":"ana@acme.dev"},{"email":"bo@fly.dev"}]', inReplyTo: award.id });
    await until(() => mail.repliesTo(submitMail).length);
    await bridge.idle();
    const verdict = mail.sent.at(-1)!;
    assert.match(verdict.text, /Verifier PASS/);
    assert.match(verdict.text, /\$1\.50 captured/);
    assert.equal((await market.getTask('poster', { task_id })).status, 'completed');

    for (const m of mail.sent.slice(1)) {
      assert.equal(m.inReplyTo, root.messageId, 'every message threads onto the root');
      assert.equal(m.subject, `Re: ${root.subject}`);
    }
  });

  it('a failed delivery lands in the thread with the reason and the refund', async () => {
    const { task_id } = await market.postTask('poster', { spec: 'two emails', verifier: SCHEMA, budget_max: 200, deadline: 600 });
    const { bid_id } = await market.bid('mallory', { task_id, price: 60, eta_seconds: 10 });
    await market.acceptBid('poster', { task_id, bid_id });
    await market.submitWork('mallory', { task_id, payload: [{ email: 'not-an-email' }] });
    await bridge.idle();
    const verdict = mail.sent.at(-1)!;
    assert.deepEqual(verdict.cc, [at('mallory')]);
    assert.match(verdict.text, /Verifier FAIL: .*must/);
    assert.match(verdict.text, /hold released, nothing charged/);
    assert.match(verdict.text, /open again/);
  });

  it('errors come back as actionable replies; strangers get nothing', async () => {
    const { task_id } = await market.postTask('poster', { spec: 'two emails', verifier: SCHEMA, budget_max: 200, deadline: 600 });
    await bridge.idle();
    const root = mail.sent[0];
    const tooHigh = mail.deliver({ from: at('swift'), to: ESCROW, subject: `Re: ${root.subject}`, text: 'BID 350 90', inReplyTo: root.id });
    await until(() => mail.repliesTo(tooHigh).length);
    assert.match(mail.repliesTo(tooHigh)[0], /"error_code":"bid_over_budget".*"fix":"bid <= 200"/);

    const stranger = mail.deliver({ from: 'someone@else.example', to: ESCROW, subject: root.subject, text: `BID 100 60 ${task_id}` });
    const handled = await until(async () => (await db.query<{ outcome: string }>('SELECT outcome FROM email_inbox WHERE email_id = $1', [stranger]))[0]?.outcome);
    assert.equal(handled, 'unknown_sender');
    assert.deepEqual(mail.repliesTo(stranger), []);
  });

  it('handles each inbound email exactly once', async () => {
    await market.postTask('poster', { spec: 'two emails', verifier: SCHEMA, budget_max: 200, deadline: 600 });
    await bridge.idle();
    const root = mail.sent[0];
    const id = mail.deliver({ from: at('swift'), to: ESCROW, subject: root.subject, text: 'BID 100 60', inReplyTo: root.id });
    await until(() => mail.repliesTo(id).length);
    await bridge.handleInbound({ id, sender: at('swift'), subject: root.subject }); // a second instance seeing the same mail
    assert.equal(mail.repliesTo(id).length, 1);
  });
});
