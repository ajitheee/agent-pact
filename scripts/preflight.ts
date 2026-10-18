// `npm run preflight`: checks everything the live demo needs, in about 10 seconds. Run it before going on stage.
// Each line is ✓ with what was confirmed, or ✗ with what to do about it. Exits 1 if anything failed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugifyDeliverable } from '../clients/slugify.js';
import { config } from '../src/config.js';
import { PrimitiveMail } from '../src/email/primitive.js';
import { Verifiers } from '../src/verifier/index.js';

const tokens = JSON.parse(readFileSync('clients/tokens.local.json', 'utf8')) as Record<string, string>;
let failures = 0;

async function check(name: string, run: () => Promise<string>, fix: string) {
  const t0 = Date.now();
  try {
    const detail = await run();
    console.log(`  \x1b[32m✓\x1b[0m ${name.padEnd(26)} ${detail} \x1b[2m(${Date.now() - t0}ms)\x1b[0m`);
  } catch (e) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name.padEnd(26)} ${(e as Error).message.slice(0, 200)}`);
    console.log(`    \x1b[33mfix:\x1b[0m ${fix}`);
  }
}

/** One MCP request to the escrow server as `agent`; returns the JSON-RPC result. */
async function mcp(agent: string, method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(tokens.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: `Bearer ${tokens[agent]}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from the escrow server`);
  const json = text.trim().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? '{}');
  const reply = JSON.parse(json) as { result?: any; error?: { message: string } };
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}
const toolText = (result: any) => String(result?.content?.[0]?.text ?? '');

console.log(`\nPreflight for the live demo against ${tokens.url}\n`);

await check(
  'Escrow server',
  async () => {
    const { tools } = await mcp('poster', 'tools/list');
    const names = (tools as { name: string }[]).map((t) => t.name);
    if (!JSON.stringify(tools).includes('wait_for_bids')) throw new Error(`answers, but runs an old build (${names.length} tools, no long-polls)`);
    return `${names.length} tools, long-polls live`;
  },
  'npm run deploy, then wait for `npx mcp-use deployments list` to show the new build (about 3 minutes)',
);

await check(
  'Agent tokens',
  async () => {
    for (const agent of ['poster', 'worker-a', 'worker-b']) {
      const text = toolText(await mcp(agent, 'tools/call', { name: 'list_open_tasks', arguments: { capability: 'code' } }));
      if (text.includes('error_code')) throw new Error(`${agent}: ${text.slice(0, 120)}`);
    }
    return 'poster, worker-a and worker-b are all accepted';
  },
  'npm run setup:clients -- --url <server>/mcp, then restart Claude Desktop so worker B gets its new token',
);

await check(
  "Server's Python sandbox",
  async () => {
    // A verifier without verify() runs in the real sandbox and is rejected at post time: no task, no email.
    const text = toolText(await mcp('poster', 'tools/call', { name: 'post_task', arguments: { spec: 'preflight', budget_max: 50, deadline: 30, verifier: { type: 'python', code: 'preflight = True' } } }));
    if (!text.includes('must define a function verify')) throw new Error(text.slice(0, 160) || 'no answer');
    return 'runs Python verifiers';
  },
  'check the deploy logs; the server needs python3 (Dockerfile) and BL_WORKSPACE / BL_API_KEY',
);

await check(
  'Blaxel',
  async () => {
    if (config.verifierSandbox !== 'blaxel') throw new Error('BL_API_KEY is not set in .env');
    const verifiers = new Verifiers();
    const spec = await verifiers.prepare({ type: 'python', code: readFileSync('clients/verifiers/slugify.py', 'utf8') });
    const verdict = await verifiers.run(spec, slugifyDeliverable());
    if (!verdict.passed) throw new Error(`worker A's slugify failed: ${verdict.reasons[0]}`);
    if (verdict.sandbox !== 'blaxel') throw new Error('Blaxel was unreachable; the check fell back to the local sandbox');
    return `the slugify tests pass on worker A's code in Blaxel (${verdict.ms}ms)`;
  },
  'check BL_WORKSPACE and BL_API_KEY in .env, and the Blaxel console for the escrow-verifier sandbox',
);

await check(
  'Stripe',
  async () => {
    if (!/^(sk|rk)_test_/.test(config.stripeKey)) throw new Error('STRIPE_SECRET_KEY is missing or not a test key');
    const res = await fetch('https://api.stripe.com/v1/account', { headers: { authorization: `Bearer ${config.stripeKey}` } });
    const account = (await res.json()) as { id?: string; settings?: { dashboard?: { display_name?: string } }; error?: { message: string } };
    if (!account.id) throw new Error(account.error?.message ?? `HTTP ${res.status}`);
    return `test mode, account "${account.settings?.dashboard?.display_name ?? account.id}"`;
  },
  'put a test-mode key (sk_test_…) in STRIPE_SECRET_KEY in .env',
);

await check(
  'Anthropic (poster)',
  async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set, so the poster would use its own Claude Code login');
    // The smallest possible request: it fails the same way the poster would if the account is out of credits.
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({ model: process.env.PREFLIGHT_MODEL ?? 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
    });
    if (!res.ok) {
      const { error } = (await res.json()) as { error?: { type: string; message: string } };
      throw new Error(error?.message ?? `HTTP ${res.status}`);
    }
    return 'the API key works and has credits';
  },
  'out of credits: add credits in the Anthropic Console (Billing). Invalid key: check ANTHROPIC_API_KEY and ANTHROPIC_WORKSPACE_ID in .env',
);

await check(
  'Primitive email',
  async () => {
    if (!process.env.PRIMITIVE_API_KEY || !config.escrowEmail) throw new Error('PRIMITIVE_API_KEY or ESCROW_EMAIL is not set');
    const mail = new PrimitiveMail(process.env.PRIMITIVE_API_KEY);
    const domain = config.escrowEmail.split('@')[1];
    await mail.poll(`poster@${domain}`, mail.startCursor(Date.now() - 3_600_000), 0);
    return `the API answers; threads go to poster@${domain}`;
  },
  'check PRIMITIVE_API_KEY and ESCROW_EMAIL in .env',
);

await check(
  'Claude Desktop (worker B)',
  async () => {
    const path = join(process.env.APPDATA ?? '', 'Claude', 'claude_desktop_config.json');
    if (!existsSync(path)) throw new Error('Claude Desktop config not found');
    const servers = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
    if (!servers['escrow-worker-b']) throw new Error('escrow-worker-b is not in the Claude Desktop config');
    return 'escrow-worker-b is configured. After a deploy, restart Claude Desktop so worker B sees the new tool options';
  },
  'quit Claude Desktop, then run node scripts/claude-desktop-worker-b.mjs (it adds the server and reopens the app)',
);

await check(
  'Poster files',
  async () => {
    const missing = ['.mcp.json', 'clients/poster.md', 'clients/verifiers/slugify.py', 'clients/worker-b.md'].filter((f) => !existsSync(f));
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
    return '.mcp.json, the poster brief, the tests and worker B prompt are in place';
  },
  'npm run setup:clients -- --url <server>/mcp writes .mcp.json; the other files are in git',
);

console.log(
  failures
    ? `\n\x1b[31m${failures} check${failures > 1 ? 's' : ''} failed.\x1b[0m Fix the ✗ lines, then run npm run preflight again.\n`
    : '\n\x1b[32mReady for the demo.\x1b[0m npm run live -- --with-worker-b\n',
);
process.exit(failures ? 1 : 0);
