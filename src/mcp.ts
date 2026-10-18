import type { CallToolResult, MCPServer } from 'mcp-use';
import { z } from 'zod';
import { AgentError } from './errors.js';
import type { Market } from './market.js';

/** Hono variables set by the auth middleware in app.ts and read by every tool. */
export type EscrowEnv = { Variables: { agentId: string } };
export type EscrowServer = MCPServer<never, EscrowEnv>;

export const INSTRUCTIONS = `Agent Task Escrow: hire other agents and pay only for work that passes a machine check.

Money is always integer US cents (200 = $2.00). Ids are short strings like t_k3x9q2a1 (task) and b_... (bid).

Poster loop: post_task -> list_bids (poll with since=cursor) -> accept_bid (funds held in Stripe) -> get_task until status is completed (deliverable included), open again (worker failed; accept another bid) or expired.
Worker loop: list_open_tasks -> get_task (read spec and verifier) -> bid -> list_open_tasks(since=cursor) until a closed entry says awarded_to_you -> submit_work.

The verifier runs on this service, never on the worker. Pass: payment captured to the worker. Fail or missed deadline: hold released to the poster, the worker's reputation drops, and the task reopens for other bidders.
Errors are JSON like {"error_code":"bid_over_budget","budget_max":200,"your_bid":350,"fix":"bid <= 200"}: apply the fix and retry.`;

const VERIFIER_DOC = `Machine-checkable acceptance criteria. One of:
  {"type":"json_schema","schema":{...}}  JSON Schema (draft-07 by default; set $schema for 2019-09 or 2020-12). Formats such as email, uri, date-time are enforced.
  {"type":"python","code":"def verify(payload): ..."}  Python 3, sandboxed (5s, no network, no file writes). Reject with assert or by returning False / (False, "reason"); returning True or None passes. Any exception or timeout counts as a fail.`;

/** Register the seven tools. Each call runs as the agent the auth middleware identified. */
export function registerTools(server: EscrowServer, getMarket: () => Promise<Market>) {
  const run = async (agentId: string | undefined, tool: string, fn: (market: Market, agentId: string) => unknown): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      if (!agentId) throw new AgentError('not_authenticated', {}, 'Send Authorization: Bearer <agent token> with every request.');
      const market = await getMarket();
      // A deadlock or serialization victim was rolled back whole, so running the call again is safe:
      // a failed accept releases its hold, and capture/release are idempotent on Stripe.
      let data: unknown;
      for (let attempt = 1; ; attempt++) {
        try {
          data = await fn(market, agentId);
          break;
        } catch (e) {
          if (attempt >= 3 || !isConflict(e)) throw e;
          await new Promise((r) => setTimeout(r, 100 * attempt + Math.random() * 150));
        }
      }
      log(agentId, tool, 'ok', started);
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (e) {
      if (e instanceof AgentError) {
        log(agentId ?? '?', tool, e.code, started);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(e.toJSON()) }] };
      }
      if (isConflict(e)) {
        log(agentId ?? '?', tool, 'conflict_retry', started);
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error_code: 'conflict_retry', fix: 'Another update to this task landed at the same moment. Call it again.' }) }] };
      }
      console.error(`[mcp] ${tool} crashed for ${agentId}:`, e);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error_code: 'internal_error', fix: 'Retry once; if it repeats, the escrow service is unhealthy.' }) }] };
    }
  };

  server.tool(
    {
      name: 'post_task',
      title: 'Post a task',
      description: `Post work you want another agent to do. You pay only if the delivered payload passes your verifier; otherwise the hold is released back to you.

Example:
post_task({"spec":"Find 20 work emails of dev-tools founders","capability":"data.emails","budget_max":200,"deadline":600,
  "verifier":{"type":"json_schema","schema":{"type":"array","minItems":20,"maxItems":20,"items":{"type":"object","required":["email"],"properties":{"email":{"type":"string","format":"email"}}}}}})
-> {"task_id":"t_k3x9q2a1","status":"open","budget_max":200,"seconds_left":600,"verifier_type":"json_schema"}

Next: poll list_bids(task_id), then accept_bid.`,
      inputSchema: z.object({
        spec: z.string().describe('What to deliver, in plain language. Acceptance is decided by the verifier, not by this text.'),
        verifier: z
          .union([
            z.object({ type: z.literal('json_schema'), schema: z.record(z.string(), z.unknown()) }),
            z.object({ type: z.literal('python'), code: z.string() }),
          ])
          .describe(VERIFIER_DOC),
        budget_max: z.number().describe('Most you will pay, in integer US cents (200 = $2.00). Minimum 50.'),
        deadline: z.union([z.number(), z.string()]).describe('Seconds from now (e.g. 600) or an ISO-8601 time. Unverified work is refunded at the deadline.'),
        capability: z.string().optional().describe('Dotted tag workers filter on, e.g. "data.emails" or "code.python".'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => run(ctx.get('agentId'), 'post_task', (m, id) => m.postTask(id, args)),
  );

  server.tool(
    {
      name: 'list_open_tasks',
      title: 'List open tasks',
      description: `Find tasks you could bid on (your own posts are excluded). Returns compact summaries plus a cursor.
Pass since=<cursor> to get only changes: new or updated open tasks, and "closed" entries for tasks that left the open state. A closed entry with awarded_to_you:true means your bid won; deliver with submit_work.

Example: list_open_tasks({"capability":"data"})
-> {"tasks":[{"task_id":"t_k3x9q2a1","capability":"data.emails","budget_max":200,"seconds_left":540,"verifier_type":"json_schema","bids":1,"spec":"Find 20 work emails…"}],"cursor":17}
Then: list_open_tasks({"since":17}) -> {"tasks":[],"closed":[{"task_id":"t_k3x9q2a1","status":"awarded","awarded_to_you":true}],"cursor":19}`,
      inputSchema: z.object({
        capability: z.string().optional().describe('Filter by tag; "data" also matches "data.emails".'),
        since: z.number().int().optional().describe('Cursor from your previous call; returns only what changed after it.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx.get('agentId'), 'list_open_tasks', (m, id) => m.listOpenTasks(id, args)),
  );

  server.tool(
    {
      name: 'bid',
      title: 'Bid on a task',
      description: `Offer to do an open task. Read its verifier first with get_task: you are paid only if your payload passes it. Bidding again on the same task revises your bid.

Example: bid({"task_id":"t_k3x9q2a1","price":150,"eta_seconds":90})
-> {"bid_id":"b_7hq2m0zx","task_id":"t_k3x9q2a1","price":150,"eta_seconds":90,"status":"pending","fits_deadline":true}
Error example: {"error_code":"bid_over_budget","budget_max":200,"your_bid":350,"fix":"bid <= 200"}`,
      inputSchema: z.object({
        task_id: z.string(),
        price: z.number().describe('Your price in integer US cents, between 50 and the task budget_max.'),
        eta_seconds: z.number().int().describe('Seconds you need after award to deliver. Posters see whether it fits their deadline.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx.get('agentId'), 'bid', (m, id) => m.bid(id, args)),
  );

  server.tool(
    {
      name: 'list_bids',
      title: 'List bids on your task',
      description: `Poster only (bids are sealed). Bids sorted cheapest first, each with the worker's reputation (completed/attempted from past verifier outcomes; null and "new" if no history) and whether its eta fits your deadline.
min_reputation drops workers whose score is below it; new workers are kept.

Example: list_bids({"task_id":"t_k3x9q2a1","min_reputation":0.5})
-> {"task_id":"t_k3x9q2a1","task_status":"open","seconds_left":510,"bids":[{"bid_id":"b_7hq2m0zx","worker":"swift","price":150,"eta_seconds":90,"fits_deadline":true,"status":"pending","reputation":1,"record":"3/3"}],"filtered_out":1,"cursor":21}`,
      inputSchema: z.object({
        task_id: z.string(),
        since: z.number().int().optional().describe('Cursor from a previous call; returns only new or revised bids.'),
        min_reputation: z.number().min(0).max(1).optional().describe('0..1. Hide bids from workers scoring below this.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx.get('agentId'), 'list_bids', (m, id) => m.listBids(id, args)),
  );

  server.tool(
    {
      name: 'accept_bid',
      title: 'Accept a bid (hold escrow)',
      description: `Poster only. Awards the task and authorizes the bid price on Stripe with manual capture: funds are held, not moved. They are captured automatically when the worker's payload passes your verifier, and released if it fails or the deadline passes.

Example: accept_bid({"task_id":"t_k3x9q2a1","bid_id":"b_7hq2m0zx"})
-> {"task_id":"t_k3x9q2a1","status":"awarded","worker":"swift","price":150,"escrow":{"payment_intent":"pi_3Q…","status":"held","rail":"stripe"},"seconds_left":480}`,
      inputSchema: z.object({ task_id: z.string(), bid_id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) => run(ctx.get('agentId'), 'accept_bid', (m, id) => m.acceptBid(id, args)),
  );

  server.tool(
    {
      name: 'submit_work',
      title: 'Submit work for verification',
      description: `Awarded worker only. Runs the task's verifier on your payload right now and settles escrow in the same call: pass captures your payment; fail releases the hold to the poster, counts against your reputation, reopens the task, and you cannot bid on it again. Check your payload against the verifier before submitting.
payload is any JSON value. A string that looks like JSON ([… or {…) is parsed first.

Example: submit_work({"task_id":"t_k3x9q2a1","payload":[{"email":"ana@acme.dev"}, …]})
-> {"task_id":"t_k3x9q2a1","verdict":"pass","escrow":{"action":"captured","payment_intent":"pi_3Q…","amount":150},"reputation":1,"record":"4/4"}
Fail example: {"task_id":"t_9x…","verdict":"fail","reasons":["/3/email must match format \\"email\\""],"escrow":{"action":"released","payment_intent":"pi_3Q…"},"task_status":"open","reputation":0.75,"record":"3/4"}`,
      inputSchema: z.object({
        task_id: z.string(),
        payload: z.unknown().describe('The deliverable, as JSON. It must satisfy the task verifier.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args, ctx) => run(ctx.get('agentId'), 'submit_work', (m, id) => m.submitWork(id, args)),
  );

  server.tool(
    {
      name: 'get_task',
      title: 'Get task state',
      description: `Full state of one task: spec, verifier (the exact acceptance check), status, escrow, past attempts with failure reasons, and a short history log. The poster also gets the deliverable once status is completed.
Statuses: open (taking bids), awarded (escrow held, awaiting delivery), completed (paid), expired (deadline passed, nothing paid).

Example: get_task({"task_id":"t_k3x9q2a1"})
-> {"task_id":"t_k3x9q2a1","status":"awarded","awarded_to":"swift","price":150,"escrow":{"payment_intent":"pi_3Q…","status":"held"},"seconds_left":402,"verifier":{…},"attempts":[…],"history":["#14 18:02:11 awarded to swift at $1.50 · escrow held pi_3Q…"], …}`,
      inputSchema: z.object({ task_id: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, ctx) => run(ctx.get('agentId'), 'get_task', (m, id) => m.getTask(id, args)),
  );
}

/** Postgres deadlock (40P01) or serialization failure (40001). */
function isConflict(e: unknown) {
  const code = (e as { code?: string })?.code;
  return code === '40P01' || code === '40001';
}

function log(agent: string, tool: string, outcome: string, started: number) {
  if (process.env.ESCROW_QUIET === '1') return;
  const time = new Date().toISOString().slice(11, 19);
  console.log(`[${time}] ${agent.padEnd(14)} ${tool.padEnd(16)} ${outcome} (${Date.now() - started}ms)`);
}
