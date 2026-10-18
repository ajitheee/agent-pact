// Worker A: an autonomous worker agent built on the mcp-use client (@mcp-use/client).
// It watches for open tasks, reads each task's verifier, bids, and when awarded builds a payload
// that satisfies the verifier, then submits. No human in the loop.
//
//   npm run worker:a                      honest worker, bids 150 cents / 90 s
//   npm run worker:a -- --as mallory --price 55 --eta 30 --garbage   the failure beat: real names, free-mail addresses
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { MCPClient } from '@mcp-use/client';
import { deliverable, garbage } from './contacts.js';

const { values: opts } = parseArgs({
  options: {
    as: { type: 'string', default: 'worker-a' },
    price: { type: 'string', default: '150' },
    eta: { type: 'string', default: '90' },
    capability: { type: 'string', default: 'data' },
    garbage: { type: 'boolean', default: false },
    once: { type: 'boolean', default: false }, // exit after the first settled task
  },
});
const tokens = JSON.parse(readFileSync('clients/tokens.local.json', 'utf8')) as Record<string, string>;
const me = opts.as;
const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${me} · mcp-use client] ${msg}`);

const client = new MCPClient({
  // ESCROW_AGENT_TOKEN lets an orchestrator (npm run live) run a freshly registered agent.
  mcpServers: { escrow: { url: tokens.url, headers: { Authorization: `Bearer ${process.env.ESCROW_AGENT_TOKEN ?? tokens[me]}` }, clientInfo: { name: `mcp-use-${me}`, version: '0.1.0' } } },
});
// A freshly deployed server can take a while to answer its first request; retry instead of dying.
async function connectWithRetry(attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.connect('escrow');
    } catch (e) {
      if (attempt === attempts) throw e;
      log(`connect attempt ${attempt} failed (${(e as Error).message.slice(0, 80)}); retrying in 5s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
const connection = await connectWithRetry();

async function call<T = any>(tool: string, args: Record<string, unknown>): Promise<T> {
  const result = (await connection.callTool(tool, args)) as { isError?: boolean; content: { type: string; text: string }[] };
  const data = JSON.parse(result.content[0].text);
  if (result.isError) throw Object.assign(new Error(data.error_code), { data });
  return data;
}

const bidOn = new Set<string>();
let cursor: number | undefined;
log(`connected to ${tokens.url}; watching capability "${opts.capability}"`);

for (;;) {
  const page = await call('list_open_tasks', { capability: opts.capability, ...(cursor !== undefined ? { since: cursor } : {}) });
  cursor = page.cursor;

  for (const t of page.tasks) {
    if (bidOn.has(t.task_id) || t.your_bid) continue;
    const task = await call('get_task', { task_id: t.task_id });
    const price = Math.min(Number(opts.price), task.budget_max);
    try {
      const bid = await call('bid', { task_id: t.task_id, price, eta_seconds: Number(opts.eta) });
      log(`bid ${bid.bid_id} on ${t.task_id}: ${price}¢, eta ${opts.eta}s (${task.verifier.type} verifier read)`);
    } catch (e: any) {
      log(`skipped ${t.task_id}: ${JSON.stringify(e.data ?? e.message)}`);
    }
    bidOn.add(t.task_id);
  }

  for (const c of page.closed ?? []) {
    if (!c.awarded_to_you) continue;
    const task = await call('get_task', { task_id: c.task_id });
    log(`awarded ${c.task_id}; escrow ${task.escrow?.payment_intent} held. Building the deliverable${opts.garbage ? ' (garbage)' : ''}…`);
    const payload = opts.garbage ? garbage() : deliverable(task.verifier);
    try {
      const verdict = await call('submit_work', { task_id: c.task_id, payload });
      log(`verdict ${verdict.verdict.toUpperCase()}${verdict.reasons ? ` (${verdict.reasons[0]})` : ''} · verified in ${verdict.verified_in ?? "?"} · escrow ${verdict.escrow.action} · my record ${verdict.record}`);
    } catch (e: any) {
      log(`submit failed: ${JSON.stringify(e.data ?? e.message)}`);
    }
    if (opts.once) {
      await client.close();
      process.exit(0);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
