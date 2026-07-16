'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getCommandBuilders } = require('../src/commands');

const root = path.join(__dirname, '..');
const ignored = new Set(['node_modules', 'data', '.git', 'backups', '_archive']);

function walk(directory, extension, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath, extension, result);
    else if (entry.name.endsWith(extension)) result.push(fullPath);
  }
  return result;
}

const jsFiles = walk(root, '.js');
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `${path.relative(root, file)}: ${result.stderr}`);
}

const builders = getCommandBuilders();
const commands = builders.map(builder => builder.toJSON());
const commandNames = commands.map(command => command.name);
assert.strictEqual(new Set(commandNames).size, commandNames.length, 'Command names must be unique');

const applicationSource = fs.readFileSync(path.join(root, 'src', 'application.js'), 'utf8');
const handled = new Set([...applicationSource.matchAll(/commandName\s*===\s*'([^']+)'/g)].map(match => match[1]));
for (const match of applicationSource.matchAll(/\[([^\]]+)\]\.includes\(commandName\)/gs)) {
  for (const item of match[1].matchAll(/'([^']+)'/g)) handled.add(item[1]);
}
assert.deepStrictEqual([...commandNames].sort(), [...handled].sort(), 'Deployed and handled command lists differ');

for (const command of commands) {
  assert(command.description.length >= 1 && command.description.length <= 100, `Invalid description: ${command.name}`);
  if (!['help', 'dashboard', 'security', 'status', 'securitystats', 'servercheck', 'privacy', 'terms', 'about', 'support', 'risk', 'reportscam', 'appeal'].includes(command.name)) {
    assert(command.default_member_permissions, `Administrative command lacks default permissions: ${command.name}`);
  }
}

for (const file of walk(path.join(root, 'dashboard', 'public'), '.html')) {
  const html = fs.readFileSync(file, 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.strictEqual(new Set(ids).size, ids.length, `Duplicate HTML IDs in ${path.basename(file)}`);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (!match[1].trim()) continue;
    const result = spawnSync(process.execPath, ['--check', '-'], { input: match[1], encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `Inline script error in ${path.basename(file)}: ${result.stderr}`);
  }
}

const dashboard = fs.readFileSync(path.join(root, 'dashboard', 'public', 'dashboard.html'), 'utf8');
for (const feature of ['AntiSpam', 'AntiRaid', 'AntiScam i OCR', 'AntiAlt', 'Reaction Roles', 'Channel Guard', 'Weryfikacja', 'Tickety', 'Centrum bezpieczeństwa', 'Moderacja']) {
  assert(dashboard.includes(feature), `Dashboard is missing ${feature}`);
}
function isTrackedByGit(relativePath) {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const result = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relativePath], { encoding: 'utf8' });
  return result.status === 0;
}

assert(!isTrackedByGit('.env'), 'Release must not track .env');
assert(!isTrackedByGit('config.json'), 'Release must not track private config.json');

console.log(`OK: ${jsFiles.length} plików JS, ${commands.length} komend i panel WWW.`);
