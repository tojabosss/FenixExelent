'use strict';

const ID_PATTERN = /^\d{15,22}$/;

function bool(value) { return typeof value === 'boolean' ? value : undefined; }
function number(value, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : undefined;
}
function id(value) {
  if (value === null || value === '') return null;
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}
function ids(value) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(id).filter(Boolean))].slice(0, 100);
}
function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : undefined;
}
function domains(value) {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.map(item => String(item || '').trim().toLowerCase())
    .map(item => item.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, ''))
    .filter(item => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(item)))]
    .slice(0, 500);
}
function methodIds(value) {
  if (!Array.isArray(value)) return undefined;
  const result = [...new Set(value.map(item => String(item || '').trim().toLowerCase())
    .filter(item => /^[a-z][a-z0-9_-]{0,31}$/.test(item)))].slice(0, 10);
  return result.length ? result : undefined;
}
function pick(source, schema) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const result = {};
  for (const [key, transform] of Object.entries(schema)) {
    const value = transform(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function sanitizeConfigPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid JSON object');
  const patch = {};
  const add = (key, value) => { if (value && Object.keys(value).length) patch[key] = value; };

  add('antispam', pick(body.antispam, {
    enabled: bool, maxMessages: v => number(v, 2, 20), interval: v => number(v, 1000, 60000),
    muteMinutes: v => number(v, 1, 1440), logChannel: id,
  }));
  add('antiraid', pick(body.antiraid, {
    enabled: bool, joinThreshold: v => number(v, 2, 50), joinInterval: v => number(v, 1000, 60000),
    action: v => ['kick', 'ban', 'mute'].includes(v) ? v : undefined,
    logChannel: id, lockdownActive: bool,
  }));
  add('antiscam', pick(body.antiscam, {
    enabled: bool, muteMinutes: v => number(v, 1, 1440), deleteMessage: bool, logChannel: id,
    blockScamImages: bool, ocrScamImages: bool, ocrMinScamScore: v => number(v, 1, 10),
    ocrMaxImages: v => number(v, 1, 5), ocrTimeoutMs: v => number(v, 5000, 60000),
    ocrMaxImageBytes: v => number(v, 262144, 16777216), allowScamReportsInReportChannels: bool,
    blockImageOnlyScamScreenshots: bool, whitelistedDomains: domains, blockedDomains: domains,
  }));
  add('antialt', pick(body.antialt, {
    enabled: bool, minAccountAgeDays: v => number(v, 1, 365),
    action: v => ['verify', 'kick', 'ban'].includes(v) ? v : undefined,
    logChannel: id, riskPoints: v => number(v, 1, 100),
  }));
  add('channelGuard', pick(body.channelGuard, {
    enabled: bool, blockNewChannels: bool, whitelistedRoles: ids, logChannel: id,
  }));
  add('verification', pick(body.verification, {
    enabled: bool, roleId: id, verifiedRoleId: id, unverifiedRoleId: id, channelId: id, logChannelId: id,
    methods: methodIds, sessionTtlMinutes: v => number(v, 2, 30), maxAttempts: v => number(v, 1, 20),
    rateLimitWindowMinutes: v => number(v, 1, 60),
  }));
  add('tickets', pick(body.tickets, {
    enabled: bool, categoryId: id, supportRoleId: id, logChannelId: id, panelChannelId: id,
  }));
  add('modLog', pick(body.modLog, { channelId: id }));
  add('securityIgnore', pick(body.securityIgnore, { channels: ids, roles: ids }));
  add('appeals', pick(body.appeals, { enabled: bool, channelId: id }));
  add('reactionRoles', pick(body.reactionRoles, { enabled: bool, channelId: id }));

  const modRole = id(body.modRole);
  const adminRole = id(body.adminRole);
  if (modRole !== undefined) patch.modRole = modRole;
  if (adminRole !== undefined) patch.adminRole = adminRole;

  const actions = pick(body.actions, {
    sendVerificationPanel: bool, sendTicketPanel: bool, emergencyOn: bool, emergencyOff: bool,
    createBackup: bool, restoreBackupId: v => text(v, 80), refreshStats: bool,
    createReactionRolesPanel: bool,
  }) || {};
  return { patch, actions };
}

module.exports = { sanitizeConfigPatch };
