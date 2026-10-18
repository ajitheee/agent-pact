// The poster agent: Claude Code, headless, with only the escrow MCP server and clients/poster.md as its brief.
// Auth: ANTHROPIC_API_KEY from .env when present (API credits), otherwise Claude Code's own login.
//   npm run poster              final summary only
//   npm run poster -- --stream  every tool call and result as it happens (used by npm run live)
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (existsSync('.env')) process.loadEnvFile('.env');
// Org-level API keys (not scoped to one workspace) must name the workspace to bill on every request.
if (process.env.ANTHROPIC_WORKSPACE_ID) {
  process.env.ANTHROPIC_CUSTOM_HEADERS = `anthropic-workspace-id: ${process.env.ANTHROPIC_WORKSPACE_ID}`;
}
const stream = process.argv.includes('--stream');
const pkg = join('node_modules', '@anthropic-ai', 'claude-code');
const exe = join(pkg, JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).bin.claude);
const args = [
  '-p',
  '--mcp-config', '.mcp.json',
  '--strict-mcp-config',
  '--allowedTools', 'mcp__escrow', 'Read', 'Bash(sleep:*)',
  ...(stream ? ['--output-format', 'stream-json', '--verbose'] : []),
];

console.log(
  `[poster] Claude Code, authenticated with ${process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY from .env' : 'its own login'}` +
    (process.env.ANTHROPIC_WORKSPACE_ID ? ` (workspace ${process.env.ANTHROPIC_WORKSPACE_ID})` : ''),
);
const child = spawn(exe, args, { stdio: ['pipe', stream ? 'pipe' : 'inherit', 'inherit'] });
createReadStream('clients/poster.md').pipe(child.stdin);
if (stream) createInterface({ input: child.stdout }).on('line', render);
child.on('exit', (code) => process.exit(code ?? 1));

const clip = (s, n = 170) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One stream-json event → at most a couple of readable lines. */
function render(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const blocks = event.message?.content ?? [];
  if (event.type === 'assistant') {
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        const tool = b.name.replace(/^mcp__escrow__/, '');
        // The verifier code is long; show its type, not its body.
        const input = b.input?.verifier?.code ? { ...b.input, verifier: { type: b.input.verifier.type, code: '<contacts.py>' } } : b.input;
        console.log(`→ ${tool} ${clip(JSON.stringify(input), 140)}`);
      } else if (b.type === 'text' && b.text.trim() && b.text.length < 400) {
        // Short asides narrate decisions; the long final summary is printed in full by the result event.
        console.log(`  ${clip(b.text.trim().replace(/\s+/g, ' '), 200)}`);
      }
    }
  } else if (event.type === 'user') {
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue;
      const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('') : String(b.content ?? '');
      if (text.length > 400 && text.includes('def verify')) continue; // the verifier file being read
      console.log(`← ${clip(text.replace(/\s+/g, ' '))}`);
    }
  } else if (event.type === 'result') {
    console.log(`\n${event.result ?? ''}`);
  }
}
