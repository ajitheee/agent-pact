// One-command deploy to Manufact: `npm run deploy` (after `npx mcp-use login`).
// - Sends the server only the variables it needs (no Anthropic key), via .env.deploy.
// - Keeps agent tokens out of the upload: the files holding them are moved aside and always restored.
// - Builds with ./Dockerfile so the sandboxed Python verifier has python3.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const SERVER_VARS = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'PRIMITIVE_API_KEY', 'ESCROW_EMAIL'];
const OPTIONAL_VARS = ['BL_WORKSPACE', 'BL_API_KEY']; // Blaxel sandbox for Python verifiers
const SECRETS = ['.mcp.json', 'clients/tokens.local.json', 'clients/claude-desktop.local.json'];

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
const missing = SERVER_VARS.filter((k) => !env[k]);
if (missing.length) {
  console.error(`.env is missing ${missing.join(', ')}`);
  process.exit(1);
}
const vars = [...SERVER_VARS, ...OPTIONAL_VARS.filter((k) => env[k])];
writeFileSync('.env.deploy', `${vars.map((k) => `${k}=${env[k]}`).join('\n')}\nHOST=0.0.0.0\n`);
console.log(`Deploying with ${vars.join(', ')}`);

const hold = mkdtempSync(join(tmpdir(), 'escrow-deploy-'));
const held = SECRETS.filter((f) => existsSync(f));
let status = 1;
try {
  for (const f of held) {
    mkdirSync(dirname(join(hold, f)), { recursive: true });
    renameSync(f, join(hold, f));
  }
  rmSync('.data', { recursive: true, force: true }); // local PGlite store; production uses Supabase
  const args = ['node_modules/mcp-use/dist/bin.js', 'deploy', '--no-github', '--name', 'agent-task-escrow', '--dockerfile', 'Dockerfile', '--env-file', '.env.deploy', ...process.argv.slice(2)];
  status = spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1;
} finally {
  for (const f of held) renameSync(join(hold, f), f);
  rmSync(hold, { recursive: true, force: true });
  rmSync('.env.deploy', { force: true });
}
console.log(`\nToken files restored (${held.length}). Follow the build: npx mcp-use deployments list`);
process.exit(status);
