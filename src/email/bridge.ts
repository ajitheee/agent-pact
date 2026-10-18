// Primitive email as a second transport: "the thread is the context".
//
// Outbound: every committed market event lands in one email thread per task, From the escrow mailbox, To the poster.
//   posted  → new thread, cc every other agent        (post a task → email to worker agents)
//   bid     → poster only, so bids stay sealed
//   awarded → cc the winner                           (cc the winner → award)
//   passed / failed / timed_out → cc the worker       (verifier result, payment captured or released)
// Inbound: agents can act by replying in the thread instead of calling MCP tools:
//   BID <cents> <eta seconds> · ACCEPT <bid_id> · SUBMIT <json> · STATUS
import type { Queryable } from '../db.js';
import { AgentError, errMsg } from '../errors.js';
import { usd, type Market, type MarketEvent } from '../market.js';
import { bareAddress, type InboundSummary, type MailApi, type OutboundMail } from './primitive.js';

interface ThreadRow {
  task_id: string;
  root_sent_id: string;
  root_message_id: string | null;
  subject: string;
}

type Command =
  | { kind: 'bid'; price: number; eta: number }
  | { kind: 'accept'; bidId: string }
  | { kind: 'submit'; payload: unknown }
  | { kind: 'status' };

const HELP = 'Reply with one command: BID <price in cents> <eta seconds> (e.g. BID 150 90) · ACCEPT <bid_id> · SUBMIT <json payload> · STATUS';
const CURSOR_KEY = 'email_inbound_cursor';

export class EmailBridge {
  private readonly market: Market;
  private readonly mail: MailApi;
  private readonly address: string;
  private readonly inbound: boolean;
  private readonly pollWaitSeconds: number;
  private readonly queues = new Map<string, Promise<void>>();
  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private readonly onEvent = (e: MarketEvent) => this.enqueue(e);
  /** The last few hundred messages this process sent, newest last. Primitive's thread API carries no bodies. */
  readonly recent: (OutboundMail & { task_id: string; kind: string; sent_id: string })[] = [];

  constructor(opts: { market: Market; mail: MailApi; address: string; inbound?: boolean; pollWaitSeconds?: number }) {
    this.market = opts.market;
    this.mail = opts.mail;
    this.address = opts.address.toLowerCase();
    this.inbound = opts.inbound ?? true;
    this.pollWaitSeconds = opts.pollWaitSeconds ?? 25;
  }

  start() {
    this.market.on('event', this.onEvent);
    if (this.inbound) {
      this.running = true;
      this.loopDone = this.pollLoop();
    }
    return this;
  }

  async stop() {
    this.market.off('event', this.onEvent);
    this.running = false;
    await this.loopDone;
    await this.idle();
  }

  /** Resolves once every queued outbound email has been sent (or has failed and been logged). */
  async idle() {
    while (this.queues.size) await Promise.all(this.queues.values());
  }

  /** Messages for one task go out in order, so replies always find their thread's root. */
  private enqueue(e: MarketEvent) {
    const previous = this.queues.get(e.task_id) ?? Promise.resolve();
    const next = previous
      .then(() => this.deliver(e))
      .catch((err) => console.error(`[email] ${e.type} for ${e.task_id} not sent: ${errMsg(err)}`));
    this.queues.set(e.task_id, next);
    void next.then(() => {
      if (this.queues.get(e.task_id) === next) this.queues.delete(e.task_id);
    });
  }

  // ─── outbound ─────────────────────────────────────────────────────────────

  private async deliver(e: MarketEvent) {
    const db = this.market.db;
    const task = await this.market.getTask('escrow', { task_id: e.task_id });
    const emails = await this.agentEmails(db);
    const poster = emails.get(task.poster);
    if (!poster) return; // a thread needs the poster's mailbox
    const d = e.data as Record<string, any>;

    if (e.type === 'posted') {
      const subject = `[${task.task_id}] ${clip(task.spec, 60)} · budget ${usd(task.budget_max)}`;
      const cc = [...emails].filter(([id, addr]) => id !== task.poster && addr !== this.address).map(([, addr]) => addr);
      const root: OutboundMail = { from: this.address, to: poster, cc, subject, text: renderPosted(task, e) };
      const { id } = await this.mail.send(root, `evt-${e.task_id}-${e.seq}`);
      const messageId = await this.waitForMessageId(id);
      await db.query('INSERT INTO email_threads (task_id, root_sent_id, root_message_id, subject) VALUES ($1, $2, $3, $4) ON CONFLICT (task_id) DO NOTHING', [
        task.task_id,
        id,
        messageId,
        subject,
      ]);
      await this.recordSent(id, task.task_id, e.type, root);
      return;
    }

    const thread = await this.thread(task.task_id);
    if (!thread) return; // task predates the bridge
    const worker = (d.worker as string | undefined) ?? (e.type === 'passed' || e.type === 'failed' ? e.actor : undefined);
    const cc = e.type === 'bid' || e.type === 'rebid' ? [] : [worker && emails.get(worker)].filter((a): a is string => !!a && a !== poster);
    const text = await this.render(e, task);
    if (!text) return;
    const reply: OutboundMail = {
      from: this.address,
      to: poster,
      cc,
      subject: `Re: ${thread.subject}`,
      text,
      ...(thread.root_message_id ? { inReplyTo: thread.root_message_id, references: [thread.root_message_id] } : {}),
    };
    const { id } = await this.mail.send(reply, `evt-${e.task_id}-${e.seq}`);
    await this.recordSent(id, task.task_id, e.type, reply);
  }

  private async render(e: MarketEvent, task: Awaited<ReturnType<Market['getTask']>>): Promise<string | null> {
    const d = e.data as Record<string, any>;
    const machine = `escrow-event: ${JSON.stringify({ type: e.type, task_id: e.task_id, ...d })}`;
    switch (e.type) {
      case 'bid':
      case 'rebid': {
        const rep = await this.market.reputation(this.market.db, e.actor);
        return [
          `${e.actor} ${e.type === 'rebid' ? 'revised their bid to' : 'bid'} ${usd(d.price)}, eta ${d.eta_seconds}s (${d.bid_id}). Track record: ${rep.record}.`,
          `${task.seconds_left}s left before the deadline.`,
          '',
          `To award it, reply: ACCEPT ${d.bid_id}`,
          '',
          machine,
        ].join('\n');
      }
      case 'awarded':
        return [
          `Awarded to ${d.worker} at ${usd(d.price)}.`,
          `Escrow: ${usd(d.price)} authorized on Stripe and held, not captured (${d.payment_intent}).`,
          '',
          `${d.worker}: deliver by replying SUBMIT followed by your JSON payload, or call submit_work. The verifier below decides payment:`,
          verifierText(task.verifier),
          '',
          machine,
        ].join('\n');
      case 'passed':
        return [
          `${e.actor} delivered. Verifier PASS (${d.verifier_ms}ms, ${d.sandbox === 'blaxel' ? 'in a Blaxel sandbox' : 'run by the escrow service'}).`,
          `Payment: ${usd(d.amount)} captured on Stripe (${d.payment_intent}).`,
          `${e.actor}'s track record: ${(await this.market.reputation(this.market.db, e.actor)).record}.`,
          '',
          machine,
        ].join('\n');
      case 'failed':
        return [
          `${e.actor} delivered. Verifier FAIL${d.sandbox === 'blaxel' ? ' (Blaxel sandbox)' : ''}: ${d.reason}`,
          `Payment: hold released, nothing charged (${d.payment_intent}).`,
          `${e.actor}'s track record: ${(await this.market.reputation(this.market.db, e.actor)).record}.`,
          d.reopened ? 'The task is open again for other bids.' : 'The deadline has passed; the task is closed.',
          '',
          machine,
        ].join('\n');
      case 'timed_out':
        return [`${d.worker} missed the deadline. Payment: hold released, nothing charged (${d.payment_intent}).`, '', machine].join('\n');
      case 'expired':
        return ['The deadline passed with no award. Task closed.', '', machine].join('\n');
      default:
        return null;
    }
  }

  /** Primitive assigns the Message-ID on send; poll briefly so the thread can be stitched onto it. */
  private async waitForMessageId(sentId: string) {
    for (let i = 0; i < 6; i++) {
      const id = await this.mail.messageId(sentId).catch(() => null);
      if (id) return id;
      await sleep(500);
    }
    return null;
  }

  private async thread(taskId: string): Promise<ThreadRow | undefined> {
    const [t] = await this.market.db.query<ThreadRow>('SELECT * FROM email_threads WHERE task_id = $1', [taskId]);
    if (t && !t.root_message_id) {
      t.root_message_id = await this.mail.messageId(t.root_sent_id).catch(() => null);
      if (t.root_message_id) await this.market.db.query('UPDATE email_threads SET root_message_id = $1 WHERE task_id = $2', [t.root_message_id, taskId]);
    }
    return t;
  }

  private async recordSent(sentId: string, taskId: string, kind: string, mail: OutboundMail) {
    this.recent.push({ ...mail, task_id: taskId, kind, sent_id: sentId });
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    await this.market.db.query('INSERT INTO email_sent (sent_id, task_id, kind, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [
      sentId,
      taskId,
      kind,
      this.market.now(),
    ]);
  }

  private async agentEmails(db: Queryable) {
    const rows = await db.query<{ id: string; email: string }>('SELECT id, email FROM agents WHERE email IS NOT NULL ORDER BY created_at');
    return new Map(rows.map((r) => [r.id, r.email.toLowerCase()]));
  }

  // ─── inbound ──────────────────────────────────────────────────────────────

  private async pollLoop() {
    const db = this.market.db;
    const [saved] = await db.query<{ value: string }>('SELECT value FROM kv WHERE key = $1', [CURSOR_KEY]);
    let cursor = saved?.value ?? this.mail.startCursor(this.market.now());
    while (this.running) {
      try {
        const { emails, cursor: next } = await this.mail.poll(this.address, cursor, this.pollWaitSeconds);
        for (const summary of emails) await this.handleInbound(summary);
        if (next !== cursor) {
          cursor = next;
          await db.query('INSERT INTO kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [CURSOR_KEY, cursor]);
        }
      } catch (e) {
        console.error(`[email] inbound poll failed: ${errMsg(e)}`);
        await sleep(5_000);
      }
    }
  }

  /** Turn one reply into a tool call made as the sending agent, then answer in the same thread. */
  async handleInbound(summary: InboundSummary) {
    const db = this.market.db;
    if (bareAddress(summary.sender) === this.address) return;
    // Claim it first: with several server instances polling, exactly one handles each email.
    const claimed = await db.query('INSERT INTO email_inbox (email_id, sender, received_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING email_id', [
      summary.id,
      summary.sender,
      this.market.now(),
    ]);
    if (!claimed.length) return;

    const mail = await this.mail.read(summary.id);
    const [agent] = await db.query<{ id: string }>('SELECT id FROM agents WHERE lower(email) = $1', [mail.from]);
    if (!agent) {
      // No reply to strangers: answering unknown senders would turn the escrow into a spam reflector.
      await db.query("UPDATE email_inbox SET outcome = 'unknown_sender' WHERE email_id = $1", [mail.id]);
      return;
    }

    const [sent] = mail.replyToSentId ? await db.query<{ task_id: string }>('SELECT task_id FROM email_sent WHERE sent_id = $1', [mail.replyToSentId]) : [];
    const taskId = sent?.task_id ?? /\bt_[0-9a-z]{8}\b/.exec(`${mail.subject}\n${mail.text}`)?.[0];
    const parsed = parseCommand(mail.text);

    let outcome: string;
    let answer: string;
    try {
      if ('error' in parsed) throw new AgentError('unknown_command', {}, HELP);
      if (!taskId) throw new AgentError('task_not_found', {}, 'Reply inside the task thread, or include the task id (t_…) in the subject.');
      const result = await this.run(agent.id, taskId, parsed);
      outcome = `ok:${parsed.kind}`;
      answer = `OK ${parsed.kind.toUpperCase()}\n${JSON.stringify(result)}`;
    } catch (e) {
      const err = e instanceof AgentError ? e.toJSON() : { error_code: 'internal_error', fix: 'Retry once; if it repeats, the escrow service is unhealthy.' };
      if (!(e instanceof AgentError)) console.error('[email] inbound command crashed:', e);
      outcome = `error:${err.error_code}`;
      answer = `ERROR\n${JSON.stringify(err)}\n\n${HELP}`;
    }
    await db.query('UPDATE email_inbox SET command = $1, outcome = $2 WHERE email_id = $3', ['kind' in parsed ? parsed.kind : null, outcome, mail.id]);
    await this.mail.reply(mail.id, answer, `answer-${mail.id}`).catch((e) => console.error(`[email] reply to ${mail.id} failed: ${errMsg(e)}`));
  }

  private run(agentId: string, taskId: string, cmd: Command) {
    switch (cmd.kind) {
      case 'bid':
        return this.market.bid(agentId, { task_id: taskId, price: cmd.price, eta_seconds: cmd.eta });
      case 'accept':
        return this.market.acceptBid(agentId, { task_id: taskId, bid_id: cmd.bidId });
      case 'submit':
        return this.market.submitWork(agentId, { task_id: taskId, payload: cmd.payload });
      case 'status': {
        return this.market.getTask(agentId, { task_id: taskId }).then(({ task_id, status, seconds_left, awarded_to, escrow, history }) => ({
          task_id,
          status,
          seconds_left,
          awarded_to,
          escrow,
          history: history.slice(-5),
        }));
      }
    }
  }
}

/** Parse the first command in a reply, ignoring quoted history. Exported for tests. */
export function parseCommand(text: string): Command | { error: string } {
  const body = stripQuoted(text);
  const bid = /^\s*bid\s+(\$?\d+(?:\.\d+)?)\s*(?:cents?|c)?\s+(\d+)\s*(s|secs?|seconds?|m|mins?|minutes?)?\b/im.exec(body);
  if (bid) {
    const raw = bid[1];
    const price = raw.startsWith('$') || raw.includes('.') ? Math.round(Number(raw.replace('$', '')) * 100) : Number(raw);
    const eta = Number(bid[2]) * (bid[3]?.toLowerCase().startsWith('m') ? 60 : 1);
    return { kind: 'bid', price, eta };
  }
  const accept = /^\s*accept\s+(b_[0-9a-z]+)/im.exec(body);
  if (accept) return { kind: 'accept', bidId: accept[1] };
  const submit = /^\s*submit\b/im.exec(body);
  if (submit) {
    const rest = body.slice(submit.index + submit[0].length).trim();
    try {
      return { kind: 'submit', payload: JSON.parse(rest) };
    } catch {
      return { kind: 'submit', payload: rest }; // the verifier will judge it; usually a fail with a clear reason
    }
  }
  if (/^\s*status\b/im.test(body)) return { kind: 'status' };
  return { error: 'no command' };
}

function stripQuoted(text: string): string {
  const lines = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line)) break;
    if (line.startsWith('>')) continue;
    lines.push(line);
  }
  return lines.join('\n');
}

function renderPosted(task: Awaited<ReturnType<Market['getTask']>>, e: MarketEvent): string {
  return [
    `New task ${task.task_id} from ${task.poster} · budget up to ${usd(task.budget_max)} · ${task.seconds_left}s to deliver (deadline ${task.deadline_at})`,
    '',
    task.spec,
    '',
    'Acceptance check, run by the escrow service (you are paid only if your payload passes it):',
    verifierText(task.verifier),
    '',
    'To bid, reply to this email:  BID <price in cents> <eta seconds>   e.g.  BID 150 90',
    `Or call the MCP tool bid({"task_id":"${task.task_id}","price":150,"eta_seconds":90}).`,
    '',
    `escrow-event: ${JSON.stringify({ type: e.type, task_id: e.task_id, ...e.data })}`,
  ].join('\n');
}

function verifierText(v: { type: string; schema?: unknown; code?: string }) {
  return v.type === 'python' ? `python:\n${v.code}` : `json_schema: ${JSON.stringify(v.schema)}`;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
