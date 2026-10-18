// Adds the escrow-worker-b MCP server to Claude Desktop (Windows), then reopens the app.
// Claude Desktop keeps its config in memory and rewrites the file while running, which can drop edits
// made meanwhile, so this waits until the app is closed before touching it. Run it after quitting
// Claude Desktop (tray icon → Quit): `node scripts/claude-desktop-worker-b.mjs`.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
const APP_ID = 'Claude_pzs8sxrjxfjjc!Claude'; // Claude Desktop's Store app id (Get-StartApps)

// Only the Desktop app counts (installed under WindowsApps), not the Claude Code CLI, which is also claude.exe.
const desktopRunning = () =>
  Number(
    execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*WindowsApps*' }).Count"])
      .toString()
      .trim(),
  ) > 0;

if (desktopRunning()) {
  console.log('Waiting for Claude Desktop to close. Quit it from the tray icon (right-click → Quit).');
  while (desktopRunning()) await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 1500)); // let the app finish its last write

const entry = JSON.parse(readFileSync(join(root, 'clients', 'claude-desktop.local.json'), 'utf8')).mcpServers['escrow-worker-b'];
copyFileSync(configPath, configPath.replace(/\.json$/, `.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
config.mcpServers = { ...(config.mcpServers ?? {}), 'escrow-worker-b': entry };
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Added escrow-worker-b (servers now: ${Object.keys(config.mcpServers).join(', ')}). Backup saved next to the config.`);

spawn('explorer.exe', [`shell:AppsFolder\\${APP_ID}`], { detached: true, stdio: 'ignore' }).unref();
console.log('Reopening Claude Desktop. In a new chat, paste the worker B prompt (it is on your clipboard) when the live run asks for it.');
