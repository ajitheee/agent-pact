// The poster agent: Claude Code, headless, with only the escrow MCP server and clients/poster.md as its brief.
// Auth: ANTHROPIC_API_KEY from .env when present (API credits), otherwise Claude Code's own login.
//   npm run poster              final summary only
//   npm run poster -- --stream  every tool call and result as it happens (used by npm run live)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
// The brief is a template; POSTER_SCENARIO (default ci-fix) picks the task from clients/scenarios/.
const scenario = process.env.POSTER_SCENARIO ?? 'ci-fix';
const dir = `clients/scenarios/${scenario}`;
const meta = JSON.parse(readFileSync(`${dir}/scenario.json`, 'utf8'));
const verifier = existsSync(`${dir}/verify.py`)
  ? `{"type":"python","code":<the full contents of ${dir}/verify.py, verbatim>}. Read that file and pass its text as \`code\` exactly as written.`
  : `{"type":"json_schema","schema":<the JSON object in ${dir}/schema.json, exactly as written>}. Read that file.`;
let brief = readFileSync('clients/poster.md', 'utf8')
  .replaceAll('{{NEED}}', meta.need)
  .replaceAll('{{SPEC_FILE}}', `${dir}/spec.txt`)
  .replaceAll('{{CAPABILITY}}', meta.capability)
  .replaceAll('{{BUDGET}}', String(meta.budget))
  .replaceAll('{{BUDGET_USD}}', `$${(meta.budget / 100).toFixed(2)}`)
  .replaceAll('{{VERIFIER}}', verifier)
  .replaceAll('{{CHECK}}', meta.check);
// POSTER_MIN_BIDS=3 (set by `npm run live -- --with-worker-b`) makes the poster wait for a third bid from Claude Desktop.
const minBids = Number(process.env.POSTER_MIN_BIDS ?? 2);
if (minBids !== 2) brief = brief.replace('`wait_for_bids` 2', `\`wait_for_bids\` ${minBids}`).replaceAll('2 pending bids', `${minBids} pending bids`);
child.stdin.end(brief);
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
      if (b.type === 'tool_use' && b.name === 'Read' && b.input?.file_path) {
        // The project-relative path, so viewers (and npm run live) can tell which file the poster is reading.
        console.log(`→ Read ${relative(process.cwd(), b.input.file_path).replaceAll('\\', '/')}`);
      } else if (b.type === 'tool_use') {
        const tool = b.name.replace(/^mcp__escrow__/, '');
        // The verifier code is long; show its type, not its body.
        const v = b.input?.verifier;
        const input = v?.code || v?.schema ? { ...b.input, verifier: { type: v.type, [v.code ? 'code' : 'schema']: `<${scenario} check>` } } : b.input;
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
