import { EventEmitter } from 'node:events';
import { LIMITS } from './config.js';
import type { AgentRow, AttemptRow, BidRow, Db, EventRow, Queryable, TaskRow } from './db.js';
import { AgentError, errMsg } from './errors.js';
import { newId } from './ids.js';
import type { Rail } from './rails.js';
import { coercePayload, type VerifierSpec, type Verifiers } from './verifier/index.js';

export interface MarketEvent {
  seq: number;
  task_id: string;
  actor: string;
  type: string;
  data: Record<string, unknown>;
  at: number;
}

export interface SubmitResult {
  task_id: string;
  verdict: 'pass' | 'fail';
  reasons?: string[];
  escrow: { action: 'captured' | 'released' | 'release_failed'; payment_intent: string; amount?: number };
  verified_in: 'in-process' | 'local' | 'blaxel';
  task_status?: 'open' | 'expired';
  reputation: number | null;
  record: string;
}

type Log = (taskId: string, actor: string, type: string, data: Record<string, unknown>) => Promise<number>;

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const REPUTATION_SQL = `SELECT worker_id, COUNT(*)::int AS attempted,
  SUM(CASE WHEN outcome = 'passed' THEN 1 ELSE 0 END)::int AS completed
  FROM attempts WHERE outcome IN ('passed', 'failed', 'timed_out') GROUP BY worker_id`;

/**
 * The escrow state machine. Every public method takes the calling agent's id first.
 *
 *   open --accept_bid--> awarded --submit_work(pass)--> completed   (escrow captured)
 *                          |------submit_work(fail)--> open         (escrow released, task reopens)
 *                          '------deadline---------->  expired      (escrow released)
 *
 * Settlement runs inside a transaction holding the task row (SELECT … FOR UPDATE), so two server
 * instances, or a submit racing the deadline sweeper, cannot settle the same task twice.
 * Emits 'event' (MarketEvent) after each committed state change, for transports like email.
 */
export class Market extends EventEmitter {
  readonly db: Db;
  readonly rail: Rail;
  readonly verifiers: Verifiers;
  readonly now: () => number;

  constructor(opts: { db: Db; rail: Rail; verifiers: Verifiers; now?: () => number }) {
    super();
    this.db = opts.db;
    this.rail = opts.rail;
    this.verifiers = opts.verifiers;
    this.now = opts.now ?? Date.now;
  }

  // ─── post_task ────────────────────────────────────────────────────────────

  async postTask(actor: string, input: { spec: string; verifier: unknown; budget_max: number; deadline: number | string; capability?: string }) {
    const spec = (input.spec ?? '').trim();
    if (!spec) throw new AgentError('spec_required', {}, 'Pass spec: a plain-language description of the work. The verifier carries the acceptance criteria.');
    if (spec.length > LIMITS.maxSpecChars) throw new AgentError('spec_too_long', { max_chars: LIMITS.maxSpecChars, your_chars: spec.length }, `Shorten spec to <= ${LIMITS.maxSpecChars} characters.`);
    const budget = cents('budget_max', input.budget_max);
    if (budget < LIMITS.minPrice || budget > LIMITS.maxBudget) {
      throw new AgentError('budget_out_of_range', { min: LIMITS.minPrice, max: LIMITS.maxBudget, your_budget: budget }, `${LIMITS.minPrice} <= budget_max <= ${LIMITS.maxBudget} (US cents; 200 = $2.00)`);
    }
    const deadlineAt = this.parseDeadline(input.deadline);
    const verifier = await this.verifiers.prepare(input.verifier);
    const capability = input.capability?.trim().toLowerCase() || null;

    const id = newId('t');
    await this.write(async (q, log) => {
      await q.query(
        `INSERT INTO tasks (id, poster_id, spec, capability, verifier_type, verifier, budget_max, deadline_at, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)`,
        [id, actor, spec, capability, verifier.type, JSON.stringify(verifier), budget, deadlineAt, this.now()],
      );
      await log(id, actor, 'posted', { budget_max: budget, verifier_type: verifier.type, capability });
    });
    return { task_id: id, status: 'open', budget_max: budget, seconds_left: this.secondsUntil(deadlineAt), verifier_type: verifier.type };
  }

  // ─── list_open_tasks ──────────────────────────────────────────────────────

  async listOpenTasks(actor: string, input: { capability?: string; since?: number }) {
    const now = this.now();
    const params: unknown[] = [actor];
    const where = ['t.poster_id <> $1'];
    const capability = input.capability?.trim().toLowerCase();
    if (capability) {
      params.push(capability);
      where.push(`(t.capability = $${params.length} OR t.capability LIKE ($${params.length}::text || '.%'))`);
    }
    if (input.since !== undefined) {
      params.push(input.since);
      where.push(`t.seq > $${params.length}`);
    } else {
      params.push(now);
      where.push(`t.status = 'open' AND t.deadline_at > $${params.length}`);
    }
    const rows = await this.db.query<TaskRow & { awarded_worker: string | null; pending_bids: number; my_bid_id: string | null; my_bid_price: number | null; my_bid_status: string | null }>(
      `SELECT t.*, a.worker_id AS awarded_worker,
         (SELECT COUNT(*)::int FROM bids b WHERE b.task_id = t.id AND b.status = 'pending') AS pending_bids,
         mb.id AS my_bid_id, mb.price AS my_bid_price, mb.status AS my_bid_status
       FROM tasks t
       LEFT JOIN attempts a ON a.id = t.current_attempt_id
       LEFT JOIN bids mb ON mb.task_id = t.id AND mb.worker_id = $1
       WHERE ${where.join(' AND ')}
       ORDER BY t.seq DESC LIMIT 50`,
      params,
    );
    const cursor = await this.cursor();

    const tasks = [];
    const closed = [];
    for (const t of rows) {
      if (t.status === 'open' && t.deadline_at > now) {
        tasks.push({
          task_id: t.id,
          capability: t.capability,
          budget_max: t.budget_max,
          seconds_left: this.secondsUntil(t.deadline_at),
          verifier_type: t.verifier_type,
          bids: t.pending_bids,
          spec: t.spec.length > 160 ? `${t.spec.slice(0, 157)}…` : t.spec,
          ...(t.my_bid_id ? { your_bid: { bid_id: t.my_bid_id, price: t.my_bid_price, status: t.my_bid_status } } : {}),
        });
      } else {
        closed.push({ task_id: t.id, status: t.status, ...(t.awarded_worker === actor ? { awarded_to_you: true } : {}) });
      }
    }
    return input.since === undefined ? { tasks, cursor } : { tasks, closed, cursor };
  }

  // ─── bid ──────────────────────────────────────────────────────────────────

  async bid(actor: string, input: { task_id: string; price: number; eta_seconds: number }) {
    const price = cents('price', input.price);
    const eta = input.eta_seconds;
    return this.write(async (q, log) => {
      const t = await this.lockTask(q, input.task_id);
      this.assertBeforeDeadline(t);
      if (t.status !== 'open') throw new AgentError('task_not_open', { task_id: t.id, status: t.status }, 'Only open tasks take bids. Find others with list_open_tasks.');
      if (t.poster_id === actor) throw new AgentError('cannot_bid_on_own_task', { task_id: t.id }, 'Bid on tasks other agents posted.');
      if (price > t.budget_max) throw new AgentError('bid_over_budget', { budget_max: t.budget_max, your_bid: price }, `bid <= ${t.budget_max}`);
      if (price < LIMITS.minPrice) throw new AgentError('bid_under_minimum', { min_price: LIMITS.minPrice, your_bid: price }, `bid >= ${LIMITS.minPrice} (Stripe's minimum charge)`);
      if (!Number.isInteger(eta) || eta < 1) throw new AgentError('invalid_eta', { your_eta: eta }, 'eta_seconds is a positive integer: seconds you need after award to deliver.');

      const [existing] = await q.query<BidRow>('SELECT * FROM bids WHERE task_id = $1 AND worker_id = $2', [t.id, actor]);
      if (existing?.status === 'failed') {
        throw new AgentError('already_failed_this_task', { task_id: t.id, bid_id: existing.id }, 'Your delivery failed this verifier; find another task with list_open_tasks.');
      }
      if (existing && existing.status !== 'pending') throw new AgentError('bid_locked', { bid_id: existing.id, status: existing.status }, 'Your bid was accepted; deliver with submit_work.');

      const bidId = existing?.id ?? newId('b');
      if (existing) {
        await q.query('UPDATE bids SET price = $1, eta_seconds = $2 WHERE id = $3', [price, eta, bidId]);
      } else {
        await q.query(`INSERT INTO bids (id, task_id, worker_id, price, eta_seconds, status, created_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6)`, [
          bidId,
          t.id,
          actor,
          price,
          eta,
          this.now(),
        ]);
      }
      const seq = await log(t.id, actor, existing ? 'rebid' : 'bid', { bid_id: bidId, price, eta_seconds: eta });
      await q.query('UPDATE bids SET seq = $1 WHERE id = $2', [seq, bidId]);
      return {
        bid_id: bidId,
        task_id: t.id,
        price,
        eta_seconds: eta,
        status: 'pending',
        fits_deadline: eta <= this.secondsUntil(t.deadline_at),
        ...(existing ? { revised: true } : {}),
      };
    });
  }

  // ─── list_bids ────────────────────────────────────────────────────────────

  async listBids(actor: string, input: { task_id: string; since?: number; min_reputation?: number }) {
    const t = await this.task(this.db, input.task_id);
    if (t.poster_id !== actor) throw new AgentError('not_your_task', { task_id: t.id }, 'Bids are sealed: only the poster can list them.');
    const params: unknown[] = [t.id];
    if (input.since !== undefined) params.push(input.since);
    const rows = await this.db.query<BidRow & { attempted: number; completed: number }>(
      `SELECT b.*, COALESCE(r.attempted, 0) AS attempted, COALESCE(r.completed, 0) AS completed
       FROM bids b LEFT JOIN (${REPUTATION_SQL}) r ON r.worker_id = b.worker_id
       WHERE b.task_id = $1 ${input.since !== undefined ? 'AND b.seq > $2' : ''}
       ORDER BY b.price, b.created_at`,
      params,
    );

    const secondsLeft = this.secondsUntil(t.deadline_at);
    const bids = [];
    let filtered = 0;
    for (const b of rows) {
      const rep = reputationOf(b.completed, b.attempted);
      if (input.min_reputation !== undefined && rep.reputation !== null && rep.reputation < input.min_reputation) {
        filtered++;
        continue;
      }
      bids.push({ bid_id: b.id, worker: b.worker_id, price: b.price, eta_seconds: b.eta_seconds, fits_deadline: b.eta_seconds <= secondsLeft, status: b.status, ...rep });
    }
    return {
      task_id: t.id,
      task_status: t.status,
      seconds_left: secondsLeft,
      bids,
      ...(input.min_reputation !== undefined ? { filtered_out: filtered } : {}),
      cursor: await this.cursor(),
    };
  }

  // ─── accept_bid ───────────────────────────────────────────────────────────

  async acceptBid(actor: string, input: { task_id: string; bid_id: string }) {
    // If the transaction fails after Stripe authorized the hold, nothing records it, so release it here
    // rather than leave the poster's card authorized for days.
    let placed: { id: string; attemptId: string } | undefined;
    try {
      return await this.acceptBidTx(actor, input, (id, attemptId) => (placed = { id, attemptId }));
    } catch (e) {
      if (placed) {
        await this.rail
          .release(placed.id, { verdict: 'aborted', reason: 'accept_bid did not complete' }, `release-${placed.attemptId}`)
          .catch((err) => console.error(`[escrow] could not release orphaned hold ${placed!.id}: ${errMsg(err)}`));
      }
      throw e;
    }
  }

  private acceptBidTx(actor: string, input: { task_id: string; bid_id: string }, onHold: (paymentIntent: string, attemptId: string) => void) {
    return this.write(async (q, log) => {
      const t = await this.lockTask(q, input.task_id);
      if (t.poster_id !== actor) throw new AgentError('not_your_task', { task_id: t.id }, 'Only the poster can accept bids.');
      this.assertBeforeDeadline(t);
      if (t.status !== 'open') {
        throw new AgentError('task_not_open', { task_id: t.id, status: t.status }, t.status === 'awarded' ? 'Already awarded; watch get_task for the verdict.' : undefined);
      }
      const [b] = await q.query<BidRow>('SELECT * FROM bids WHERE id = $1', [input.bid_id]);
      if (!b || b.task_id !== t.id) throw new AgentError('bid_not_found', { task_id: t.id, bid_id: input.bid_id }, 'Use a bid_id from list_bids(task_id).');
      if (b.status !== 'pending') throw new AgentError('bid_not_pending', { bid_id: b.id, status: b.status }, 'Pick a pending bid from list_bids(task_id).');

      const [worker] = await q.query<AgentRow>('SELECT * FROM agents WHERE id = $1', [b.worker_id]);
      const attemptId = newId('a');
      let hold: { id: string };
      try {
        hold = await this.rail.hold({
          amount: b.price,
          description: `Agent escrow ${t.id}: ${b.worker_id} for ${usd(b.price)}`,
          metadata: { task_id: t.id, bid_id: b.id, attempt_id: attemptId, poster: actor, worker: b.worker_id },
          idempotencyKey: `hold-${attemptId}`,
          destination: worker?.stripe_account ?? undefined,
        });
      } catch (e) {
        throw new AgentError('escrow_hold_failed', { detail: errMsg(e) }, 'Nothing was charged. Retry accept_bid or pick another bid.');
      }
      onHold(hold.id, attemptId);

      await q.query(
        `INSERT INTO attempts (id, task_id, bid_id, worker_id, amount, payment_intent, escrow, outcome, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'held', 'held', $7)`,
        [attemptId, t.id, b.id, b.worker_id, b.price, hold.id, this.now()],
      );
      await q.query("UPDATE bids SET status = 'accepted' WHERE id = $1", [b.id]);
      await q.query("UPDATE tasks SET status = 'awarded', current_attempt_id = $1 WHERE id = $2", [attemptId, t.id]);
      await log(t.id, actor, 'awarded', { worker: b.worker_id, bid_id: b.id, price: b.price, payment_intent: hold.id });
      return {
        task_id: t.id,
        status: 'awarded',
        worker: b.worker_id,
        price: b.price,
        escrow: { payment_intent: hold.id, status: 'held', rail: this.rail.name },
        seconds_left: this.secondsUntil(t.deadline_at),
      };
    });
  }

  // ─── submit_work ──────────────────────────────────────────────────────────

  async submitWork(actor: string, input: { task_id: string; payload: unknown }): Promise<SubmitResult> {
    const t = await this.task(this.db, input.task_id);
    if (t.status !== 'awarded' || !t.current_attempt_id) {
      throw new AgentError('task_not_awarded', { task_id: t.id, status: t.status }, 'Submit only after the poster accepts your bid (get_task shows awarded_to).');
    }
    const a = await this.attempt(this.db, t.current_attempt_id);
    if (a.worker_id !== actor) throw new AgentError('not_awarded_to_you', { task_id: t.id }, 'Only the agent whose bid was accepted can submit.');
    if (this.now() >= t.deadline_at) {
      await this.expire(t.id);
      throw new AgentError('deadline_passed', { task_id: t.id }, 'The escrow hold went back to the poster; find another task.');
    }
    if (input.payload === undefined) throw new AgentError('payload_required', {}, 'Pass the deliverable as payload (any JSON value).');
    const bytes = Buffer.byteLength(JSON.stringify(input.payload));
    if (bytes > LIMITS.maxPayloadBytes) {
      throw new AgentError('payload_too_large', { max_bytes: LIMITS.maxPayloadBytes, your_bytes: bytes }, `Trim payload to <= ${LIMITS.maxPayloadBytes} bytes and resubmit; nothing was judged.`);
    }

    // The verifier can take seconds (sandboxed Python), so it runs before the row lock is taken.
    const spec = JSON.parse(t.verifier) as VerifierSpec;
    const payload = coercePayload(input.payload, spec);
    const verdict = await this.verifiers.run(spec, payload);

    return this.write(async (q, log) => {
      const locked = await this.lockTask(q, t.id);
      if (locked.status !== 'awarded' || locked.current_attempt_id !== a.id) {
        throw new AgentError('task_changed', { task_id: t.id, status: locked.status }, 'The task settled or expired while your work was being verified; check get_task.');
      }

      if (verdict.passed) {
        try {
          await this.rail.capture(a.payment_intent, { verdict: 'pass', verifier: spec.type }, `capture-${a.id}`);
        } catch (e) {
          throw new AgentError('escrow_capture_failed', { payment_intent: a.payment_intent, detail: errMsg(e) }, 'Your work passed but capture failed; call submit_work again to retry.');
        }
        await q.query("UPDATE attempts SET outcome = 'passed', escrow = 'captured', payload = $1, resolved_at = $2 WHERE id = $3", [JSON.stringify(payload), this.now(), a.id]);
        await q.query("UPDATE bids SET status = 'won' WHERE id = $1", [a.bid_id]);
        await q.query("UPDATE bids SET status = 'lost' WHERE task_id = $1 AND status = 'pending'", [t.id]);
        await q.query("UPDATE tasks SET status = 'completed' WHERE id = $1", [t.id]);
        await log(t.id, actor, 'passed', { amount: a.amount, payment_intent: a.payment_intent, verifier_ms: verdict.ms, sandbox: verdict.sandbox });
        return {
          task_id: t.id,
          verdict: 'pass' as const,
          escrow: { action: 'captured' as const, payment_intent: a.payment_intent, amount: a.amount },
          verified_in: verdict.sandbox,
          ...(await this.reputation(q, actor)),
        };
      }

      const reason = verdict.reasons.join('; ');
      let escrow: 'released' | 'release_failed' = 'released';
      try {
        await this.rail.release(a.payment_intent, { verdict: 'fail', reason: reason.slice(0, 450) }, `release-${a.id}`);
      } catch (e) {
        escrow = 'release_failed'; // the sweeper retries; the hold also lapses on its own
        console.error(`[escrow] release failed for ${a.payment_intent}: ${errMsg(e)}`);
      }
      const reopened = this.now() < t.deadline_at;
      await q.query("UPDATE attempts SET outcome = 'failed', escrow = $1, reason = $2, payload = $3, resolved_at = $4 WHERE id = $5", [
        escrow,
        reason,
        JSON.stringify(payload),
        this.now(),
        a.id,
      ]);
      await q.query("UPDATE bids SET status = 'failed' WHERE id = $1", [a.bid_id]);
      await q.query('UPDATE tasks SET status = $1, current_attempt_id = NULL WHERE id = $2', [reopened ? 'open' : 'expired', t.id]);
      await log(t.id, actor, 'failed', { reason, payment_intent: a.payment_intent, reopened, sandbox: verdict.sandbox });
      return {
        task_id: t.id,
        verdict: 'fail' as const,
        reasons: verdict.reasons,
        escrow: { action: escrow, payment_intent: a.payment_intent },
        verified_in: verdict.sandbox,
        task_status: reopened ? ('open' as const) : ('expired' as const),
        ...(await this.reputation(q, actor)),
      };
    });
  }

  // ─── get_task ─────────────────────────────────────────────────────────────

  async getTask(actor: string, input: { task_id: string }) {
    const t = await this.task(this.db, input.task_id);
    const attempts = await this.db.query<AttemptRow>('SELECT * FROM attempts WHERE task_id = $1 ORDER BY created_at', [t.id]);
    const [{ n: pendingBids }] = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM bids WHERE task_id = $1 AND status = 'pending'", [t.id]);
    const events = await this.db.query<EventRow>('SELECT * FROM events WHERE task_id = $1 ORDER BY seq DESC LIMIT 20', [t.id]);
    const current = attempts.find((a) => a.id === t.current_attempt_id);
    const passed = attempts.find((a) => a.outcome === 'passed');

    return {
      task_id: t.id,
      status: t.status,
      poster: t.poster_id,
      capability: t.capability,
      spec: t.spec,
      verifier: JSON.parse(t.verifier),
      budget_max: t.budget_max,
      seconds_left: this.secondsUntil(t.deadline_at),
      deadline_at: new Date(t.deadline_at).toISOString(),
      pending_bids: pendingBids,
      ...(current ? { awarded_to: current.worker_id, price: current.amount, escrow: { payment_intent: current.payment_intent, status: current.escrow } } : {}),
      attempts: attempts.map((a) => ({ worker: a.worker_id, price: a.amount, outcome: a.outcome, escrow: a.escrow, ...(a.reason ? { reason: a.reason } : {}) })),
      // The deliverable is the poster's property; workers never see each other's output.
      ...(passed && t.poster_id === actor ? { deliverable: JSON.parse(passed.payload!) } : {}),
      history: events.reverse().map(describeEvent),
    };
  }

  // ─── reputation & deadlines ───────────────────────────────────────────────

  /** completed / attempted over every award that reached a verdict (pass, fail, or missed deadline). */
  async reputation(q: Queryable, agentId: string) {
    const [r] = await q.query<{ attempted: number; completed: number }>(`SELECT * FROM (${REPUTATION_SQL}) r WHERE worker_id = $1`, [agentId]);
    return reputationOf(r?.completed ?? 0, r?.attempted ?? 0);
  }

  /** Expire tasks past their deadline and release any escrow they hold. Safe to call often, from any instance. */
  async sweep() {
    const due = await this.db.query<{ id: string }>("SELECT id FROM tasks WHERE status IN ('open', 'awarded') AND deadline_at <= $1", [this.now()]);
    for (const { id } of due) await this.expire(id);

    const stuck = await this.db.query<AttemptRow>("SELECT * FROM attempts WHERE escrow = 'release_failed'");
    for (const a of stuck) {
      try {
        await this.rail.release(a.payment_intent, { verdict: a.outcome }, `release-${a.id}`);
        await this.db.query("UPDATE attempts SET escrow = 'released' WHERE id = $1", [a.id]);
      } catch {
        /* retry on the next sweep */
      }
    }
  }

  private async expire(taskId: string) {
    await this.write(async (q, log) => {
      const t = await this.lockTask(q, taskId);
      if (t.deadline_at > this.now()) return;
      if (t.status === 'awarded' && t.current_attempt_id) {
        const a = await this.attempt(q, t.current_attempt_id);
        let escrow = 'released';
        try {
          await this.rail.release(a.payment_intent, { verdict: 'timed_out' }, `release-${a.id}`);
        } catch (e) {
          escrow = 'release_failed';
          console.error(`[escrow] release failed for ${a.payment_intent}: ${errMsg(e)}`);
        }
        await q.query("UPDATE attempts SET outcome = 'timed_out', escrow = $1, reason = 'deadline passed before a passing delivery', resolved_at = $2 WHERE id = $3", [
          escrow,
          this.now(),
          a.id,
        ]);
        await q.query("UPDATE bids SET status = 'failed' WHERE id = $1", [a.bid_id]);
        await q.query("UPDATE bids SET status = 'lost' WHERE task_id = $1 AND status = 'pending'", [t.id]);
        await q.query("UPDATE tasks SET status = 'expired', current_attempt_id = NULL WHERE id = $1", [t.id]);
        await log(t.id, 'escrow', 'timed_out', { worker: a.worker_id, payment_intent: a.payment_intent });
      } else if (t.status === 'open') {
        await q.query("UPDATE bids SET status = 'lost' WHERE task_id = $1 AND status = 'pending'", [t.id]);
        await q.query("UPDATE tasks SET status = 'expired' WHERE id = $1", [t.id]);
        await log(t.id, 'escrow', 'expired', {});
      }
    });
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async task(q: Queryable, id: string): Promise<TaskRow> {
    const [t] = await q.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]);
    if (!t) throw new AgentError('task_not_found', { task_id: id }, 'Get valid task ids from list_open_tasks.');
    return t;
  }

  /** Read the task and hold its row lock until the surrounding transaction ends. */
  private async lockTask(q: Queryable, id: string): Promise<TaskRow> {
    const [t] = await q.query<TaskRow>('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw new AgentError('task_not_found', { task_id: id }, 'Get valid task ids from list_open_tasks.');
    return t;
  }

  private async attempt(q: Queryable, id: string): Promise<AttemptRow> {
    const [a] = await q.query<AttemptRow>('SELECT * FROM attempts WHERE id = $1', [id]);
    return a;
  }

  private assertBeforeDeadline(t: TaskRow) {
    if (this.now() >= t.deadline_at) throw new AgentError('task_expired', { task_id: t.id }, 'The deadline passed; pick another task from list_open_tasks.');
  }

  private parseDeadline(d: number | string): number {
    const now = this.now();
    const at =
      typeof d === 'number' ? now + d * 1000
      : /^\s*\d+\s*$/.test(String(d)) ? now + Number(d) * 1000
      : Date.parse(String(d));
    if (!Number.isFinite(at)) {
      throw new AgentError('invalid_deadline', { got: d }, 'Pass seconds from now (e.g. 600) or an ISO-8601 time like 2026-10-18T03:00:00Z.');
    }
    const seconds = Math.round((at - now) / 1000);
    if (seconds < LIMITS.minDeadlineSeconds || seconds > LIMITS.maxDeadlineSeconds) {
      throw new AgentError(
        'deadline_out_of_range',
        { min_seconds: LIMITS.minDeadlineSeconds, max_seconds: LIMITS.maxDeadlineSeconds, your_seconds: seconds },
        `${LIMITS.minDeadlineSeconds} <= deadline <= ${LIMITS.maxDeadlineSeconds} seconds (card holds lapse after ~7 days)`,
      );
    }
    return at;
  }

  private secondsUntil(at: number) {
    return Math.max(0, Math.floor((at - this.now()) / 1000));
  }

  private async cursor(): Promise<number> {
    const [{ c }] = await this.db.query<{ c: number }>('SELECT COALESCE(MAX(seq), 0)::int AS c FROM events');
    return c;
  }

  /** Run fn in a transaction with an audit logger; emit the logged events only once committed. */
  private async write<T>(fn: (q: Queryable, log: Log) => Promise<T>): Promise<T> {
    const events: MarketEvent[] = [];
    const result = await this.db.tx(async (q) => {
      // Append to the task's audit log (its "thread") and bump its cursor.
      const log: Log = async (taskId, actor, type, data) => {
        const at = this.now();
        const [{ seq }] = await q.query<{ seq: number }>('INSERT INTO events (task_id, actor, type, data, at) VALUES ($1, $2, $3, $4, $5) RETURNING seq', [
          taskId,
          actor,
          type,
          JSON.stringify(data),
          at,
        ]);
        await q.query('UPDATE tasks SET seq = $1 WHERE id = $2', [seq, taskId]);
        events.push({ seq, task_id: taskId, actor, type, data, at });
        return seq;
      };
      return fn(q, log);
    });
    for (const e of events) this.emit('event', e);
    return result;
  }
}

function reputationOf(completed: number, attempted: number) {
  return {
    reputation: attempted ? Math.round((completed / attempted) * 100) / 100 : null,
    record: attempted ? `${completed}/${attempted}` : 'new',
  };
}

/** Money is integer cents. Catch the classic dollars-for-cents mistake with a usable suggestion. */
function cents(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AgentError('invalid_amount', { field, got: value ?? null }, `${field} is integer US cents, e.g. 150 for $1.50.`);
  if (!Number.isInteger(value)) {
    const suggestion = Math.round(value * 100);
    throw new AgentError('amount_must_be_cents', { field, got: value, did_you_mean: suggestion }, `${field} = ${suggestion}`);
  }
  return value;
}

function describeEvent(e: EventRow): string {
  const d = JSON.parse(e.data) as Record<string, any>;
  const time = new Date(e.at).toISOString().slice(11, 19);
  const text = (() => {
    switch (e.type) {
      case 'posted': return `posted by ${e.actor} · budget ${usd(d.budget_max)} · ${d.verifier_type} verifier`;
      case 'bid': return `${e.actor} bid ${usd(d.price)}, eta ${d.eta_seconds}s (${d.bid_id})`;
      case 'rebid': return `${e.actor} revised bid to ${usd(d.price)}, eta ${d.eta_seconds}s (${d.bid_id})`;
      case 'awarded': return `awarded to ${d.worker} at ${usd(d.price)} · escrow held ${d.payment_intent}`;
      case 'passed': return `${e.actor} delivered · verifier PASS · ${usd(d.amount)} captured`;
      case 'failed': return `${e.actor} delivered · verifier FAIL (${d.reason}) · escrow released${d.reopened ? ' · task reopened' : ''}`;
      case 'timed_out': return `${d.worker} missed the deadline · escrow released`;
      case 'expired': return 'deadline passed with no award';
      default: return e.type;
    }
  })();
  return `#${e.seq} ${time} ${text}`;
}
