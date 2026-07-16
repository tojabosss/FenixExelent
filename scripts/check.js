'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getCommandBuilders } = require('../src/commands');
const { defaultGuildConfig } = require('../src/config/defaultGuildConfig');

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
const supportLanguages = defaultGuildConfig().supportLanguages;
assert(supportLanguages && typeof supportLanguages === 'object', 'Default config is missing supportLanguages');
assert.strictEqual(supportLanguages.enabled, true, 'Support languages must be enabled by default on the official guild');
assert.deepStrictEqual(supportLanguages.supported, ['pl', 'en', 'tr', 'de', 'fr'], 'Invalid support language list');
assert.deepStrictEqual(supportLanguages.roleIds, {}, 'Support language role IDs must start empty');
assert.deepStrictEqual(supportLanguages.channelIds, {}, 'Support language channel IDs must start empty');

const supportHandlerStart = applicationSource.indexOf('async function handleSupportLanguageButton');
assert(supportHandlerStart >= 0, 'Support language button handler is missing');
const supportHandlerHeader = applicationSource.slice(supportHandlerStart, supportHandlerStart + 1_500);
assert(supportHandlerHeader.includes('await interaction.deferReply({ flags: MessageFlags.Ephemeral })'), 'Support language handler must acknowledge clicks immediately');
assert(supportHandlerHeader.includes('isOfficialSupportGuild(interaction.guild)'), 'Support language handler must be limited to the official support guild');
assert(applicationSource.includes("interaction.customId.startsWith('supportlang:')"), 'Support language buttons are not dispatched');
assert(applicationSource.includes('.setCustomId(`supportlang:${language.code}`)'), 'Support language panel buttons are missing');
assert(applicationSource.includes("['Zweryfikowany', 'Verified', 'Członek', 'Member']"), 'Verified role recovery is missing');
assert(applicationSource.includes('await member.roles.set([...finalRoleIds]'), 'Support language roles must be updated atomically');

const commandAccessStart = applicationSource.indexOf('function canUseCommand');
const commandAccessEnd = applicationSource.indexOf('function canUseStaffButton', commandAccessStart);
assert(commandAccessStart >= 0 && commandAccessEnd > commandAccessStart, 'Command access control is missing');
const commandAccessSource = applicationSource.slice(commandAccessStart, commandAccessEnd);
const supportGateIndex = commandAccessSource.indexOf('isOfficialSupportGuild(interaction.guild)');
const publicGateIndex = commandAccessSource.indexOf('PUBLIC_COMMANDS.has(commandName)');
assert(supportGateIndex >= 0 && supportGateIndex < publicGateIndex, 'Official support guild must be restricted before public commands');
assert(commandAccessSource.includes('return isOwnerOrDeveloper(interaction)'), 'Support commands must be limited to owner/developer');
assert(applicationSource.includes("process.env.DEVELOPER_ID || ''"), 'Developer user access is missing');
assert(applicationSource.includes("process.env.DEVELOPER_ROLE_ID || ''"), 'Developer role access is missing');
assert(applicationSource.includes('isOfficialSupportGuild(message.guild) && !isOwnerOrDeveloper(message)'), 'Text commands bypass support access control');
assert(applicationSource.includes('function canUseStaffButton') && applicationSource.includes('function canUseAdminButton'), 'Privileged buttons bypass support access control');
assert(applicationSource.includes("configuredOwnerId || (isOfficialSupportGuild(context?.guild) ? DEFAULT_OWNER_ID : '')"), 'Default owner access must be limited to the support guild');
const adminButtonStart = applicationSource.indexOf('function canUseAdminButton');
const adminButtonEnd = applicationSource.indexOf('function getAccountAgeDays', adminButtonStart);
const adminButtonSource = applicationSource.slice(adminButtonStart, adminButtonEnd);
assert(adminButtonSource.includes('PermissionFlagsBits.Administrator'), 'Lockdown must keep its original Administrator requirement outside support');
assert(!adminButtonSource.includes('isAdminMember('), 'Support button gate must not expand permissions on other guilds');

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

const landing = fs.readFileSync(path.join(root, 'dashboard', 'public', 'index.html'), 'utf8');
for (const id of ['heroGuilds', 'heroMembers', 'heroPing', 'bandGuilds', 'bandMembers', 'bandPing', 'bandUptime']) {
  assert(landing.includes(`id="${id}"`), `Landing page is missing live statistic ${id}`);
}
assert(landing.includes("fetch('/api/stats'"), 'Landing page must load live statistics');
assert(landing.includes("localStorage.setItem('fenix.language'"), 'Language selection must be persisted');
assert(!landing.includes('1<span>K+</span>') && !landing.includes('50<span>K+</span>'), 'Landing page contains fake statistics');

function isTrackedByGit(relativePath) {
  if (!fs.existsSync(path.join(root, '.git'))) return false;
  const result = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', relativePath], { encoding: 'utf8' });
  return result.status === 0;
}

assert(!isTrackedByGit('.env'), 'Release must not track .env');
assert(!isTrackedByGit('config.json'), 'Release must not track private config.json');

console.log(`OK: ${jsFiles.length} plików JS, ${commands.length} komend i panel WWW.`);
