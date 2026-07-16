'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const temporaryDirectory = path.join(os.tmpdir(), `fenix-db-check-${process.pid}-${Date.now()}`);
process.env.DATABASE_URL = '';
process.env.DATA_DIR = temporaryDirectory;

async function main() {
  const database = require('../src/services/database');
  const options = { legacyPath: null, defaultPort: 3999, defaultUrl: 'http://127.0.0.1:3999' };
  const config = await database.loadConfig(options);
  assert.strictEqual(config.dashboardPort, 3999);
  config.guilds.test = { antispam: { enabled: true } };
  await database.saveConfig(config);
  const reloaded = await database.loadConfig(options);
  assert.strictEqual(reloaded.guilds.test.antispam.enabled, true);
  await database.writeAudit({ guildId: 'test', userId: 'tester', eventType: 'db_check', payload: { ok: true } });
  assert(fs.existsSync(database.localConfigPath));
  await database.closeDatabase();
  console.log('OK: lokalny zapis konfiguracji i audit log.');
}

main().finally(() => {
  const resolved = path.resolve(temporaryDirectory);
  if (resolved.startsWith(path.resolve(os.tmpdir())) && fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
