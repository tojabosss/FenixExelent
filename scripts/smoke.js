'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const port = 4400 + (process.pid % 400);
const temporaryDirectory = path.join(os.tmpdir(), `fenix-smoke-${process.pid}-${Date.now()}`);
const child = spawn(process.execPath, ['index.js'], {
  cwd: root,
  env: {
    ...process.env,
    BOT_TOKEN: '', CLIENT_ID: '', CLIENT_SECRET: '', DATABASE_URL: '',
    DATA_DIR: temporaryDirectory, DASHBOARD_ONLY: 'true', NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-more-than-32-characters',
    PORT: String(port), DASHBOARD_URL: `http://127.0.0.1:${port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Aplikacja zakończyła się przed testem:\n${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`);
      if (response.ok) return response.json();
    } catch {}
    await delay(250);
  }
  throw new Error(`Timeout uruchamiania dashboardu:\n${output}`);
}

async function main() {
  const ping = await waitForServer();
  assert.strictEqual(ping.ok, true);
  assert.strictEqual(ping.storage, 'json-file');
  const dashboard = await (await fetch(`http://127.0.0.1:${port}/dashboard.html`)).text();
  assert(dashboard.includes('AntiScam i OCR'));
  assert(dashboard.includes('Centrum bezpieczeństwa'));
  const statsResponse = await fetch(`http://127.0.0.1:${port}/api/stats`);
  assert.strictEqual(statsResponse.status, 200);
  console.log('OK: aplikacja, /ping, dashboard i API statystyk.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (child.exitCode === null) child.kill('SIGTERM');
  await delay(400);
  const resolved = path.resolve(temporaryDirectory);
  if (resolved.startsWith(path.resolve(os.tmpdir())) && fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
});
