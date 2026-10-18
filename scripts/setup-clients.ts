// One command to wire every demo client to the escrow server:
//   npm run setup:clients                         (local dev server, http://localhost:3000/mcp)
//   npm run setup:clients -- --url https://…/mcp  (a deployed server)
// Registers poster / worker-a / worker-b / mallory (fresh tokens each run) and writes:
//   clients/tokens.local.json         tokens for the scripted clients (worker A, the scripted demo)
//   .mcp.json                         Claude Code, as the poster
//   clients/claude-desktop.local.json the block to merge into Claude Desktop's config, as worker B
// Against local PGlite, stop `npm run dev` first (one process at a time); Supabase has no such limit.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mintToken } from '../src/agents.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';

const { values } = parseArgs({ options: { url: { type: 'string' } } });
const url = values.url ?? 'http://localhost:3000/mcp';
const domain = config.escrowEmail.split('@')[1] ?? 'agents.test';
const AGENTS = ['poster', 'worker-a', 'worker-b', 'mallory'] as const;

const db = await openDb();
const tokens: Record<string, string> = {};
try {
  for (const id of AGENTS) tokens[id] = await mintToken(db, id, { email: `${id}@${domain}` });
} finally {
  await db.close();
}

const write = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
write('clients/tokens.local.json', { url, ...tokens });
write('.mcp.json', {
  mcpServers: { escrow: { type: 'http', url, headers: { Authorization: `Bearer ${tokens.poster}` } } },
});
// Claude Desktop launches stdio servers; mcp-remote bridges to our HTTP endpoint and adds the header.
// The header goes through env because Windows splits args on spaces. On Windows, npx is a .cmd shim that
// Claude Desktop can't launch directly, so it goes through cmd.exe.
const bridge = ['-y', 'mcp-remote@0.15.1', url, '--header', 'Authorization:${ESCROW_AUTH}'];
write('clients/claude-desktop.local.json', {
  mcpServers: {
    'escrow-worker-b': {
      ...(process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', ...bridge] } : { command: 'npx', args: bridge }),
      env: { ESCROW_AUTH: `Bearer ${tokens['worker-b']}` },
    },
  },
});

console.log(`Registered ${AGENTS.join(', ')} on ${url} (emails @${domain}). Wrote:`);
console.log('  .mcp.json                          → Claude Code (poster)');
console.log('  clients/claude-desktop.local.json  → merge into Claude Desktop config (worker B)');
console.log('  clients/tokens.local.json          → worker A (mcp-use client) and scripted runs');
