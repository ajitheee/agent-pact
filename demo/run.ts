// Scripted end-to-end demo: four agents talk to the escrow service over MCP (Streamable HTTP).
// Deterministic on purpose: this is the backup for the live LLM-agent demo and the e2e test.
//
//   npm run demo                      in-process server, temp DB, Stripe if STRIPE_SECRET_KEY is set
//   npm run demo -- --fast            no pauses
//   npm run demo -- --url https://…/mcp --tokens tokens.json   against a deployed server
//     tokens.json: {"poster":"agt_…","swift":"agt_…","thrifty":"agt_…","mallory":"agt_…"}
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { addAgent } from '../src/agents.js';
import { createEscrowServer } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { EmailBridge } from '../src/email/bridge.js';
import { FakeMail, PrimitiveMail } from '../src/email/primitive.js';
import { Market, usd } from '../src/market.js';
import { railFromEnv, stripeDashboardBase } from '../src/rails.js';
import { Verifiers } from '../src/verifier/index.js';

const { values: flags } = parseArgs({ options: { url: { type: 'string' }, tokens: { type: 'string' }, fast: { type: 'boolean' } } });
const PACE = flags.fast ? 0 : Number(process.env.DEMO_PACE_MS ?? 700);
process.env.ESCROW_QUIET = '1'; // the in-process server's request log would interleave with the narration
const AGENTS = ['poster', 'swift', 'thrifty', 'mallory'] as const;
type Name = (typeof AGENTS)[number];

const COLOR: Record<Name, string> = { poster: '36', swift: '32', thrifty: '33', mallory: '35' };
const paint = (code: string, s: string) => `\x1b[${code}m${s}\x1b[0m`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = async (s: string) => { console.log(paint('2', `   ${s}`)); await sleep(PACE); };
const banner = async (s: string) => { console.log(`\n${paint('1', `━━ ${s} ${'━'.repeat(Math.max(0, 66 - s.length))}`)}`); await sleep(PACE); };
const short = (v: unknown, n = 150) => { const s = JSON.stringify(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

type Agent = {
  name: Name;
  call: (tool: string, args: Record<string, unknown>) => Promise<any>;
  /** Same call, not narrated: for polling. */
  quiet: (tool: string, args: Record<string, unknown>) => Promise<any>;
};

async function connect(name: Name, url: string, token: string): Promise<Agent> {
  const client = new Client({ name: `demo-${name}`, version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const invoke = async (tool: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    return { isError: result.isError, data: JSON.parse(result.content[0].text) };
  };
  return {
    name,
    async call(tool, args) {
      console.log(`${paint(COLOR[name], name.padStart(8))} → ${paint('1', tool)} ${paint('2', short(args, 110))}`);
      const { isError, data } = await invoke(tool, args);
      console.log(`${' '.repeat(8)} ${isError ? paint('31', '✗') : '←'} ${short(data)}`);
      await sleep(PACE);
      return data;
    },
    quiet: async (tool, args) => (await invoke(tool, args)).data,
  };
}

async function until(check: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the email to be processed');
    await sleep(200);
  }
}

/** The email side of the demo: agents replying in the task thread, and the thread itself. */
interface Inbox {
  transport: string;
  /** `name` replies in the task's thread with `text` (e.g. "BID 80 300"). */
  reply(name: Name, taskId: string, text: string): Promise<void>;
  /** Every message the escrow sent in the task's thread, oldest first. */
  thread(taskId: string): Promise<{ to: string; cc: string[]; subject: string; text: string }[]>;
  /** Live Primitive only: what Primitive itself reports for the thread. */
  proof(taskId: string): Promise<string | null>;
}

async function boot(): Promise<{ url: string; tokens: Record<Name, string>; rail: string; inbox?: Inbox; stop: () => Promise<void> }> {
  if (flags.url) {
    if (!flags.tokens) throw new Error('--url needs --tokens <file.json> mapping poster/swift/thrifty/mallory to bearer tokens');
    return { url: flags.url, tokens: JSON.parse(readFileSync(flags.tokens, 'utf8')), rail: 'remote', stop: async () => {} };
  }
  const db = await openDb({ url: null, dir: null }); // throwaway in-memory Postgres
  const market = new Market({ db, rail: railFromEnv(), verifiers: new Verifiers() });

  // Real Primitive when configured (agents get addresses on the escrow's domain), otherwise an in-memory fake.
  const live = config.primitiveApiKey && config.escrowEmail;
  const escrowAddress = live ? config.escrowEmail : 'escrow@agents.test';
  const domain = escrowAddress.split('@')[1];
  const mail = live ? new PrimitiveMail(config.primitiveApiKey, config.primitiveApiBase) : new FakeMail();
  const bridge = new EmailBridge({ market, mail, address: escrowAddress, pollWaitSeconds: live ? 25 : 0.1 }).start();

  const tokens = {} as Record<Name, string>;
  for (const a of AGENTS) tokens[a] = await addAgent(db, a, { email: `${a}@${domain}` });
  const server = createEscrowServer({ market, requestLog: false });
  const { port } = await server.listen(0);
  const sweeper = setInterval(() => void market.sweep(), 1000);

  const rootOf = async (taskId: string) => {
    await bridge.idle();
    const [t] = await db.query<{ root_sent_id: string; root_message_id: string | null; subject: string }>('SELECT * FROM email_threads WHERE task_id = $1', [taskId]);
    return t;
  };
  const inbox: Inbox = {
    transport: live ? `Primitive (${escrowAddress})` : 'in-memory Primitive stand-in',
    async reply(name, taskId, text) {
      const root = await rootOf(taskId);
      const from = `${name}@${domain}`;
      if (mail instanceof FakeMail) {
        mail.deliver({ from, to: escrowAddress, subject: `Re: ${root.subject}`, text, inReplyTo: root.root_sent_id });
      } else {
        const ref = root.root_message_id ?? undefined;
        await mail.send({ from, to: escrowAddress, subject: `Re: ${root.subject}`, text, inReplyTo: ref, references: ref ? [ref] : undefined }, `demo-${taskId}-${name}-${Date.now()}`);
      }
    },
    async thread(taskId) {
      await bridge.idle();
      return bridge.recent.filter((m) => m.task_id === taskId).map((m) => ({ to: m.to, cc: m.cc ?? [], subject: m.subject, text: m.text }));
    },
    async proof(taskId) {
      if (!(mail instanceof PrimitiveMail)) return null;
      // Ask Primitive itself: which thread did the root land in, and how many deliveries does it hold?
      const root = await rootOf(taskId);
      const api = async (path: string) =>
        (await fetch(`${config.primitiveApiBase}${path}`, { headers: { Authorization: `Bearer ${config.primitiveApiKey}` } }).then((r) => r.json())) as { data: any };
      const threadId = (await api(`/sent-emails/${root.root_sent_id}`)).data.thread_id as string;
      // Each send lands once per recipient (to + cc). Wait for the stragglers so the count shown is final.
      const expected = bridge.recent.filter((m) => m.task_id === taskId).reduce((n, m) => n + 1 + (m.cc?.length ?? 0), 0);
      let delivered = 0;
      for (let i = 0; i < 20 && delivered < expected; i++) {
        if (i) await sleep(1000);
        const thread = (await api(`/threads/${threadId}`)).data as { messages: { direction: string }[] };
        delivered = thread.messages.filter((m) => m.direction === 'inbound').length;
      }
      return `Primitive thread ${threadId}: ${delivered} of ${expected} copies delivered to agent inboxes`;
    },
  };

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    tokens,
    rail: market.rail.name,
    inbox,
    stop: async () => {
      clearInterval(sweeper);
      await bridge.stop();
      await server.close();
      await db.close();
    },
  };
}

// ─── deliverables ──────────────────────────────────────────────────────────
const FIRST = ['ana', 'bo', 'cy', 'dee', 'eli', 'fay', 'gus', 'hal', 'ivy', 'jo', 'kai', 'lu', 'max', 'nia', 'oz', 'pia', 'quin', 'rae', 'sol', 'tess'];
const COMPANIES = ['acme', 'buildkite', 'cortex', 'dagster', 'encore', 'fly', 'graphite', 'hex', 'inngest', 'jam', 'knock', 'linear', 'modal', 'neon', 'orb', 'pylon', 'quadratic', 'resend', 'stytch', 'trunk'];
const honestLeads = () => FIRST.map((n, i) => ({ name: n, email: `${n}@${COMPANIES[i]}.dev` }));
const garbageLeads = () => FIRST.map((n) => ({ name: n, email: `${n}.founder@gmail.com` })); // looks fine, isn't

const EMAIL_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'array',
    minItems: 20,
    maxItems: 20,
    items: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } },
  },
};

const WORK_EMAIL_VERIFIER = {
  type: 'python',
  code: `FREE_MAIL = {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "proton.me"}

def verify(rows):
    assert isinstance(rows, list), f"expected a list, got {type(rows).__name__}"
    assert len(rows) == 20, f"expected 20 rows, got {len(rows)}"
    seen = set()
    for i, row in enumerate(rows):
        email = str(row.get("email", "")).strip().lower()
        local, at, domain = email.partition("@")
        assert at and local and "." in domain, f"row {i}: {email!r} is not an email"
        assert domain not in FREE_MAIL, f"row {i}: {domain} is free mail, not a work address"
        assert domain not in seen, f"row {i}: duplicate company {domain}"
        seen.add(domain)
`,
};

/** The poster's policy: cheapest bid whose ETA fits the time left. */
function choose(bids: any[]) {
  return bids.filter((b) => b.status === 'pending' && b.fits_deadline).sort((a, b) => a.price - b.price)[0];
}

async function main() {
  const { url, tokens, rail, inbox, stop } = await boot();
  const [poster, swift, thrifty, mallory] = await Promise.all(AGENTS.map((a) => connect(a, url, tokens[a])));
  const intents: { pi: string; label: string }[] = [];

  console.log(paint('1', '\nAgent Task Escrow: verification layer for agent-to-agent payments'));
  await say(`MCP endpoint ${url} · escrow rail: ${rail}${inbox ? ` · email: ${inbox.transport}` : ''}`);

  // ── Act 1: happy path, poster picks on deadline ──────────────────────────
  await banner('1. Poster needs 20 founder emails and cannot get them itself');
  const t1 = await poster.call('post_task', {
    spec: 'Compile 20 dev-tools founder contacts as JSON: [{"name","email"}].',
    capability: 'data.emails',
    budget_max: 200,
    deadline: 180,
    verifier: EMAIL_SCHEMA,
  });
  await say('Acceptance criteria are a JSON Schema, not prose. Nobody has to judge "good enough".');

  await banner('2. Workers discover the task and bid');
  const seen = await swift.call('list_open_tasks', { capability: 'data' });
  await swift.call('bid', { task_id: t1.task_id, price: 150, eta_seconds: 90 });
  if (inbox) {
    // Same market, second transport: thrifty never touches MCP for its bid. It replies to the task email.
    console.log(`${paint(COLOR.thrifty, 'thrifty'.padStart(8))} ✉ ${paint('1', 'replies to the task email')} ${paint('2', '"BID 80 300"')}`);
    await inbox.reply('thrifty', t1.task_id, 'BID 80 300');
    await until(async () => (await poster.quiet('list_bids', { task_id: t1.task_id })).bids.some((b: any) => b.worker === 'thrifty'));
    await say('The escrow read the reply, placed the bid as thrifty, and answered in the same thread.');
  } else {
    await thrifty.call('bid', { task_id: t1.task_id, price: 80, eta_seconds: 300 });
  }

  const bids1 = await poster.call('list_bids', { task_id: t1.task_id });
  const pick1 = choose(bids1.bids);
  const cheap = bids1.bids.find((b: any) => b.worker === 'thrifty');
  await say(`thrifty is cheaper (${usd(cheap.price)}) but needs ${cheap.eta_seconds}s with ${bids1.seconds_left}s left → poster picks ${pick1.worker} at ${usd(pick1.price)}`);

  await banner('3. Accept: funds authorized and held in escrow');
  const a1 = await poster.call('accept_bid', { task_id: t1.task_id, bid_id: pick1.bid_id });
  intents.push({ pi: a1.escrow.payment_intent, label: `${t1.task_id} swift ${usd(a1.price)}` });
  await say(`${a1.escrow.payment_intent} is requires_capture: money held, not moved.`);

  const delta = await swift.call('list_open_tasks', { since: seen.cursor });
  if (delta.closed.some((c: any) => c.task_id === t1.task_id && c.awarded_to_you)) await say('swift sees awarded_to_you and delivers.');
  await swift.call('submit_work', { task_id: t1.task_id, payload: honestLeads() });
  await say('Verifier ran on the escrow service, passed, and the capture settled in the same call.');

  // ── Act 2: the failure ───────────────────────────────────────────────────
  await banner('4. The failure demo: a cheap agent submits plausible garbage');
  const t2 = await poster.call('post_task', {
    spec: '20 work emails of dev-tools founders, each at a different company. No free-mail addresses.',
    capability: 'data.emails',
    budget_max: 100,
    deadline: 600,
    verifier: WORK_EMAIL_VERIFIER,
  });
  await say('This time the verifier is a sandboxed Python assertion function: no network, no file writes, 5s budget.');
  await mallory.call('bid', { task_id: t2.task_id, price: 55, eta_seconds: 30 });
  await swift.call('bid', { task_id: t2.task_id, price: 95, eta_seconds: 60 });

  const bids2 = await poster.call('list_bids', { task_id: t2.task_id });
  const pick2 = choose(bids2.bids);
  await say(`${pick2.worker} is cheapest and has no record yet (${pick2.record}), so it gets a shot.`);
  const a2 = await poster.call('accept_bid', { task_id: t2.task_id, bid_id: pick2.bid_id });
  intents.push({ pi: a2.escrow.payment_intent, label: `${t2.task_id} mallory ${usd(a2.price)}` });

  const fail = await mallory.call('submit_work', { task_id: t2.task_id, payload: garbageLeads() });
  await say(paint('31', `FAIL: ${fail.reasons[0]}`));
  await say(`Escrow ${fail.escrow.action} (${fail.escrow.payment_intent}) · mallory is now ${fail.record} · task is ${fail.task_status} again.`);
  await mallory.call('bid', { task_id: t2.task_id, price: 50, eta_seconds: 30 });

  await banner('5. The market heals itself, and no human touched anything');
  const bids3 = await poster.call('list_bids', { task_id: t2.task_id, min_reputation: 0.5 });
  const pick3 = choose(bids3.bids);
  await say(`min_reputation 0.5 filtered out ${bids3.filtered_out} bidder · next pick: ${pick3.worker} (${pick3.record})`);
  const a3 = await poster.call('accept_bid', { task_id: t2.task_id, bid_id: pick3.bid_id });
  intents.push({ pi: a3.escrow.payment_intent, label: `${t2.task_id} swift ${usd(a3.price)}` });
  await swift.call('submit_work', { task_id: t2.task_id, payload: honestLeads() });

  const final = await poster.call('get_task', { task_id: t2.task_id });
  await banner('Contract history (the thread)');
  for (const line of final.history) console.log(`   ${line}`);
  await say(`deliverable: ${final.deliverable.length} rows, e.g. ${JSON.stringify(final.deliverable[0])}`);

  if (inbox) {
    await banner(`The email thread for ${t2.task_id}: negotiation to settlement, no human read it`);
    for (const m of await inbox.thread(t2.task_id)) {
      const who = `to ${m.to.split('@')[0]}${m.cc.length ? `, cc ${m.cc.map((c) => c.split('@')[0]).join(' ')}` : ''}`;
      const first = m.text.split('\n')[0];
      console.log(`   ✉ ${paint('2', who.padEnd(34))} ${first.length > 96 ? `${first.slice(0, 95)}…` : first}`);
    }
    const proof = await inbox.proof(t2.task_id);
    if (proof) await say(proof);
  }

  await banner('Settlement');
  const dashboard = config.stripeKey ? await stripeDashboardBase() : '';
  for (const { pi, label } of intents) {
    const link = pi.startsWith('pi_fake') ? '' : `  ${dashboard}/payments/${pi}`;
    console.log(`   ${label.padEnd(30)} ${pi}${link}`);
  }
  const reps = await poster.call('list_bids', { task_id: t2.task_id });
  for (const b of reps.bids) console.log(`   ${b.worker.padEnd(10)} reputation ${String(b.reputation).padEnd(5)} (${b.record})`);

  await stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
