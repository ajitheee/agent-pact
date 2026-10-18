// Primitive (primitive.dev) agent email over its REST API. Shapes follow https://api.primitive.dev/v1 OpenAPI.
// The SDK's send() has no cc, and cc is how an award loops the winner in, so this talks REST directly.
import { newId } from '../ids.js';

export interface OutboundMail {
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

export interface InboundSummary {
  id: string;
  sender: string;
  subject: string | null;
}

export interface InboundMail {
  id: string;
  from: string; // bare address
  subject: string;
  text: string;
  replyToSentId: string | null; // which of our sent emails this answers, when Primitive can tell
}

/** The slice of Primitive the bridge needs. FakeMail implements it for tests and offline demos. */
export interface MailApi {
  /** Cursor that starts the inbound stream at "now", so old mail is never replayed as commands. */
  startCursor(now: number): string;
  send(mail: OutboundMail, idempotencyKey: string): Promise<{ id: string }>;
  /** Message-ID of a sent email, for threading later sends onto it. Null until Primitive assigns one. */
  messageId(sentId: string): Promise<string | null>;
  /** Long-poll new inbound mail for one mailbox after `since`. */
  poll(recipient: string, since: string, waitSeconds: number): Promise<{ emails: InboundSummary[]; cursor: string }>;
  read(id: string): Promise<InboundMail>;
  reply(emailId: string, text: string, idempotencyKey: string): Promise<void>;
}

export class PrimitiveMail implements MailApi {
  private readonly apiKey: string;
  private readonly base: string;

  constructor(apiKey: string, base = 'https://api.primitive.dev/v1') {
    this.apiKey = apiKey;
    this.base = base.replace(/\/$/, '');
  }

  startCursor(now: number) {
    return `${new Date(now).toISOString()}|00000000-0000-0000-0000-000000000000`;
  }

  async send(mail: OutboundMail, idempotencyKey: string) {
    const body = {
      from: mail.from,
      to: mail.to,
      ...(mail.cc?.length ? { cc: mail.cc } : {}),
      subject: mail.subject,
      body_text: mail.text,
      ...(mail.inReplyTo ? { in_reply_to: mail.inReplyTo, references: mail.references ?? [mail.inReplyTo] } : {}),
    };
    const res = await this.call<{ data: { id: string } }>('POST', '/send-mail', body, idempotencyKey);
    return { id: res.data.id };
  }

  async messageId(sentId: string) {
    const res = await this.call<{ data: { message_id?: string | null } }>('GET', `/sent-emails/${sentId}`);
    return res.data.message_id ?? null;
  }

  async poll(recipient: string, since: string, waitSeconds: number) {
    const q = new URLSearchParams({ recipient, since, wait: String(waitSeconds), limit: '50' });
    const res = await this.call<{ data?: { id: string; sender: string; subject?: string | null }[]; meta: { cursor: string | null } }>('GET', `/emails?${q}`);
    return { emails: (res.data ?? []).map((e) => ({ id: e.id, sender: e.sender, subject: e.subject ?? null })), cursor: res.meta.cursor ?? since };
  }

  async read(id: string): Promise<InboundMail> {
    const res = await this.call<{ data: { id: string; from_email?: string; sender: string; subject?: string | null; body_text?: string | null; reply_to_sent_email_id?: string | null } }>('GET', `/emails/${id}`);
    const e = res.data;
    return { id: e.id, from: bareAddress(e.from_email ?? e.sender), subject: e.subject ?? '', text: e.body_text ?? '', replyToSentId: e.reply_to_sent_email_id ?? null };
  }

  async reply(emailId: string, text: string, idempotencyKey: string) {
    await this.call('POST', `/emails/${emailId}/reply`, { body_text: text }, idempotencyKey);
  }

  private async call<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45_000), // long-polls wait up to 30s
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`primitive ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** In-memory Primitive for tests and the offline demo: records every send, lets callers inject replies. */
export class FakeMail implements MailApi {
  readonly sent: (OutboundMail & { id: string; messageId: string })[] = [];
  private readonly inbox: (InboundMail & { recipient: string; seq: number })[] = [];
  private readonly replies: { emailId: string; text: string }[] = [];
  private seq = 0;
  private waiters: (() => void)[] = [];

  startCursor() {
    return String(this.seq);
  }

  async send(mail: OutboundMail) {
    const id = newId('sent', 10);
    this.sent.push({ ...mail, id, messageId: `<${id}@fake.primitive>` });
    return { id };
  }

  async messageId(sentId: string) {
    return this.sent.find((s) => s.id === sentId)?.messageId ?? null;
  }

  /** An agent replies by email. `inReplyTo` is the sent email it answers. */
  deliver(mail: { from: string; to: string; subject: string; text: string; inReplyTo?: string }) {
    const id = newId('in', 10);
    this.inbox.push({ id, recipient: mail.to, from: mail.from, subject: mail.subject, text: mail.text, replyToSentId: mail.inReplyTo ?? null, seq: ++this.seq });
    for (const wake of this.waiters.splice(0)) wake();
    return id;
  }

  async poll(recipient: string, since: string, waitSeconds: number) {
    const after = Number(since) || 0;
    const pending = () => this.inbox.filter((m) => m.recipient === recipient && m.seq > after);
    if (!pending().length && waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitSeconds * 1000);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    const emails = pending();
    return { emails: emails.map((m) => ({ id: m.id, sender: m.from, subject: m.subject })), cursor: String(emails.at(-1)?.seq ?? after) };
  }

  async read(id: string) {
    const m = this.inbox.find((e) => e.id === id);
    if (!m) throw new Error(`no inbound email ${id}`);
    return m;
  }

  async reply(emailId: string, text: string) {
    this.replies.push({ emailId, text });
  }

  repliesTo(emailId: string) {
    return this.replies.filter((r) => r.emailId === emailId).map((r) => r.text);
  }
}

export function bareAddress(s: string): string {
  return (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();
}
