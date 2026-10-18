import { MCPServer } from 'mcp-use';
import { agentForToken } from './agents.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { EmailBridge } from './email/bridge.js';
import { PrimitiveMail } from './email/primitive.js';
import { errMsg } from './errors.js';
import { Market } from './market.js';
import { INSTRUCTIONS, registerTools, type EscrowEnv, type EscrowServer } from './mcp.js';
import { railFromEnv } from './rails.js';
import { Verifiers } from './verifier/index.js';

/** Open the database from env (Supabase via DATABASE_URL, else local PGlite) and start the deadline sweeper. */
export async function marketFromEnv(): Promise<Market> {
  const db = await openDb();
  const market = new Market({ db, rail: railFromEnv(), verifiers: new Verifiers() });
  setInterval(() => {
    market.sweep().catch((e) => console.error('[sweep]', errMsg(e)));
  }, config.sweepIntervalMs).unref();
  console.log(`[escrow] db=${db.kind} rail=${market.rail.name}`);
  if (db.kind === 'pglite') {
    console.warn('[escrow] DATABASE_URL not set: using local PGlite. Fine for dev; a deploy needs Supabase so state survives restarts.');
  }
  if (config.primitiveApiKey && config.escrowEmail) {
    new EmailBridge({ market, mail: new PrimitiveMail(config.primitiveApiKey, config.primitiveApiBase), address: config.escrowEmail, inbound: config.emailInbound }).start();
    console.log(`[escrow] email threads via Primitive from ${config.escrowEmail}${config.emailInbound ? ' (replies accepted)' : ''}`);
  }
  return market;
}

/**
 * The escrow MCP server. The market is created lazily on the first request, so `mcp-use build`
 * can import this module without a database or Stripe key.
 */
export function createEscrowServer(opts: { market?: Market; requestLog?: boolean } = {}): EscrowServer {
  let ready: Promise<Market> | undefined = opts.market ? Promise.resolve(opts.market) : undefined;
  const getMarket = () =>
    (ready ??= marketFromEnv().catch((e) => {
      ready = undefined; // let the next request retry instead of failing forever
      throw e;
    }));

  const server: EscrowServer = new MCPServer<never, EscrowEnv>({
    name: 'agent-task-escrow',
    title: 'Agent Task Escrow',
    version: '0.2.0',
    description: 'Verification layer for agent-to-agent payments: escrow is captured only when a machine-checkable verifier passes.',
    instructions: INSTRUCTIONS,
    logging: { enabled: opts.requestLog ?? true },
  });

  // Every MCP request is made by a registered agent; its id flows to the tools via ctx.get('agentId').
  server.use('/mcp', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1]?.trim();
    const market = await getMarket();
    const agent = token ? await agentForToken(market.db, token) : undefined;
    if (!agent) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized: send Authorization: Bearer <agent token> (mint one with `npm run agent -- add <id>`)' }, id: null },
        401,
      );
    }
    c.set('agentId', agent.id);
    return next();
  });

  // Machine-readable discovery for agents that land on the bare host. No human UI.
  server.get('/', (c) =>
    c.json({
      name: 'agent-task-escrow',
      mcp: '/mcp',
      health: '/health',
      auth: 'Authorization: Bearer <agent token>',
      tools: ['post_task', 'list_open_tasks', 'bid', 'list_bids', 'accept_bid', 'submit_work', 'get_task'],
    }),
  );

  server.get('/health', async (c) => {
    const market = await getMarket();
    return c.json({ ok: true, db: market.db.kind, rail: market.rail.name, python_verifier: config.verifierSandbox });
  });

  registerTools(server, getMarket);
  return server;
}
