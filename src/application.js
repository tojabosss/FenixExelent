// FenixExelent Security 3.2
// Bot Discord, ochrona serwera, moderacja oraz panel WWW.

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  AuditLogEvent,
  MessageFlags,
} = require('discord.js');

require('dotenv').config();
const axios   = require('axios');
const { logger } = require('./services/logger');

let Tesseract = null;
try {
  Tesseract = require('tesseract.js');
} catch (err) {
  logger.warn('⚠️ OCR AntiScam wyłączony: brakuje paczki tesseract.js. Uruchom npm install.');
}

const path    = require('path');
let dashboardHttpServer = null;

// ─── CONFIG / STORAGE ─────────────────────────────────────────────────────
const database = require('./services/database');
const { defaultGuildConfig } = require('./config/defaultGuildConfig');
const { startDashboardServer } = require('./dashboard/server');

const LEGACY_CONFIG_PATH = path.join(__dirname, '..', 'config.json');
let config = null;

async function initializeConfig() {
  config = await database.loadConfig({
    legacyPath: LEGACY_CONFIG_PATH,
    defaultPort: parseInt(process.env.PORT, 10) || 3000,
    defaultUrl: process.env.DASHBOARD_URL || `http://localhost:${parseInt(process.env.PORT, 10) || 3000}`,
  });
}

function saveConfig() {
  return database.saveConfig(config);
}

function getGuildConfig(guildId) {
  if (!config.guilds[guildId]) config.guilds[guildId] = defaultGuildConfig();
  const gc = config.guilds[guildId];
  const def = defaultGuildConfig();
  for (const key of Object.keys(def)) {
    if (gc[key] === undefined || gc[key] === null) gc[key] = def[key];
    else if (typeof def[key] === 'object' && !Array.isArray(def[key])) gc[key] = Object.assign({}, def[key], gc[key]);
  }
  return gc;
}

// ─── DISCORD CLIENT ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

// ─── STATE ─────────────────────────────────────────────────────────────────
const spamMap    = new Map(); // userId -> timestamp[]
const mutedUsers = new Set(); // userId
const joinMap    = new Map(); // guildId -> timestamp[]
const recentJoinMap = new Map(); // guildId:userId -> timestamp
const fastJoinRiskGiven = new Set(); // guildId:userId
const scamReports = new Map(); // reportId -> report data

// ─── HELPERS ───────────────────────────────────────────────────────────────
function embed(color, title, desc, fields = []) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc)
    .setTimestamp()
    .setFooter({ text: 'FenixExelent 🔥' });
  if (fields.length) e.addFields(fields);
  return e;
}

async function sendLog(guild, channelId, embedObj) {
  if (!channelId) return;
  try {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    if (ch) await ch.send({ embeds: [embedObj] }).catch(() => {});
  } catch {}
}

async function sendModLog(guild, action, target, mod, reason, color = '#ff6b00') {
  const gc = getGuildConfig(guild.id);
  if (!gc.modLog.channelId) return;
  await sendLog(guild, gc.modLog.channelId, embed(
    color,
    `🔧 Akcja moderacyjna — ${action}`,
    'Podjęto akcję wobec użytkownika.',
    [
      { name: 'Użytkownik', value: `${target.tag || target} (${target.id || target})`, inline: true  },
      { name: 'Moderator',  value: `${mod.tag || mod.username} (${mod.id})`,           inline: true  },
      { name: 'Powód',      value: reason || 'Brak',                                   inline: false },
    ]
  ));
}


function ensureSecurityStats(gc) {
  if (!gc.securityStats) gc.securityStats = {};
  gc.securityStats = Object.assign({
    scamsBlocked: 0,
    spamMuted: 0,
    raidsDetected: 0,
    altDetections: 0,
    reportsCreated: 0,
    emergencyActivations: 0,
    backupsCreated: 0,
    appealsCreated: 0,
  }, gc.securityStats);
  return gc.securityStats;
}

function ensureRiskScores(gc) {
  if (!gc.antiscam) gc.antiscam = {};
  if (!gc.antiscam.riskScores) gc.antiscam.riskScores = {};
  return gc.antiscam.riskScores;
}

function getUserRiskData(gc, userId) {
  const scores = ensureRiskScores(gc);
  const current = scores[userId];

  if (!current || typeof current === 'number') {
    scores[userId] = {
      score: typeof current === 'number' ? current : 0,
      events: [],
      updatedAt: new Date().toISOString(),
    };
  }

  if (!Array.isArray(scores[userId].events)) scores[userId].events = [];
  if (typeof scores[userId].score !== 'number') scores[userId].score = 0;

  return scores[userId];
}

function getRiskLevel(score) {
  if (score >= 80) return { label: '🔴 Krytyczny', color: '#ff0000' };
  if (score >= 50) return { label: '🟠 Wysoki', color: '#ff6b00' };
  if (score >= 20) return { label: '🟡 Podejrzany', color: '#f59e0b' };
  return { label: '🟢 Normalny', color: '#2ed573' };
}

function addRisk(gc, userId, points, reason, meta = {}) {
  if (!userId || !points) return null;

  const data = getUserRiskData(gc, userId);
  data.score = Math.max(0, Math.min(100, data.score + points));
  data.updatedAt = new Date().toISOString();
  data.events.unshift({
    points,
    reason,
    date: data.updatedAt,
    ...meta,
  });
  data.events = data.events.slice(0, 15);

  return data;
}

function getBestLogChannelId(gc) {
  return gc.antiscam?.logChannel || gc.modLog?.channelId || gc.antiraid?.logChannel || gc.antispam?.logChannel || null;
}

function isStaffMember(member, gc) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (member.permissions.has(PermissionFlagsBits.BanMembers)) return true;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
  if (gc.adminRole && member.roles.cache.has(gc.adminRole)) return true;
  if (gc.modRole && member.roles.cache.has(gc.modRole)) return true;
  return false;
}

const PUBLIC_COMMANDS = new Set([
  'help', 'dashboard', 'security', 'status', 'securitystats', 'servercheck',
  'privacy', 'terms', 'about', 'support', 'reportscam',
]);

const ADMIN_COMMANDS = new Set([
  'setup', 'stats', 'modlog', 'antispam', 'antiraid', 'antiscam', 'scamdomains',
  'ocrscan', 'antialt', 'reactionroles', 'channelguard', 'securityignore', 'verification', 'ticket',
  'backup', 'emergency', 'refreshbot', 'botserver',
]);

function isAdminMember(member, gc) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return !!(gc.adminRole && member.roles.cache.has(gc.adminRole));
}

function isOwnerOrDeveloper(interaction) {
  const ownerId = String(process.env.OWNER_ID || '').trim();
  const developerRoleId = String(process.env.DEVELOPER_ROLE_ID || '').trim();
  return (ownerId && interaction.user?.id === ownerId) ||
    (developerRoleId && interaction.member?.roles?.cache?.has(developerRoleId));
}

function canUseCommand(interaction, gc, commandName) {
  if (PUBLIC_COMMANDS.has(commandName)) return true;
  if (isOwnerOrDeveloper(interaction)) return true;
  if (commandName === 'appeal') {
    const subcommand = interaction.options.getSubcommand(false);
    if (subcommand === 'submit') return true;
    if (subcommand === 'setup') return isAdminMember(interaction.member, gc);
    return isStaffMember(interaction.member, gc);
  }
  if (commandName === 'risk') {
    const requestedUser = interaction.options.getUser('uzytkownik');
    return !requestedUser || requestedUser.id === interaction.user.id || isStaffMember(interaction.member, gc);
  }
  if (ADMIN_COMMANDS.has(commandName)) return isAdminMember(interaction.member, gc);
  return isStaffMember(interaction.member, gc);
}

function getAccountAgeDays(user) {
  const created = user?.createdTimestamp || 0;
  if (!created) return 9999;
  return Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000));
}

function makeReportId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function buildScamReportButtons(reportId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`scamreport:block:${reportId}`)
      .setLabel('✅ Dodaj domenę')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`scamreport:mute:${reportId}`)
      .setLabel('🔇 Mute')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`scamreport:ban:${reportId}`)
      .setLabel('🔨 Ban')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`scamreport:reject:${reportId}`)
      .setLabel('❌ Odrzuć')
      .setStyle(ButtonStyle.Secondary),
  )];
}

function buildDisabledScamReportButtons(reportId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scamreport:block:${reportId}`).setLabel('✅ Dodaj domenę').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`scamreport:mute:${reportId}`).setLabel('🔇 Mute').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`scamreport:ban:${reportId}`).setLabel('🔨 Ban').setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId(`scamreport:reject:${reportId}`).setLabel('❌ Odrzuć').setStyle(ButtonStyle.Secondary).setDisabled(true),
  )];
}

function getFirstDomainFromText(text) {
  const domains = extractDomains(String(text || ''));
  return domains.find(d => !isSafeDomain(d)) || domains[0] || null;
}

function formatUptime(seconds) {
  const s = Math.max(0, Number(seconds || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function aggregateSecurityStats() {
  const totals = {
    scamsBlocked: 0,
    spamMuted: 0,
    raidsDetected: 0,
    altDetections: 0,
    reportsCreated: 0,
    emergencyActivations: 0,
    backupsCreated: 0,
    appealsCreated: 0,
  };

  for (const guildId of Object.keys(config.guilds || {})) {
    const gc = getGuildConfig(guildId);
    const stats = ensureSecurityStats(gc);
    totals.scamsBlocked += Number(stats.scamsBlocked || 0);
    totals.spamMuted += Number(stats.spamMuted || 0);
    totals.raidsDetected += Number(stats.raidsDetected || 0);
    totals.altDetections += Number(stats.altDetections || 0);
    totals.reportsCreated += Number(stats.reportsCreated || 0);
    totals.emergencyActivations += Number(stats.emergencyActivations || 0);
  }

  return totals;
}

async function setGuildEmergencyLockdown(guild, active) {
  let changed = 0;
  let failed = 0;

  for (const [, ch] of guild.channels.cache) {
    if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildCategory) {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: active ? false : null,
        CreateInstantInvite: active ? false : null,
      }).then(() => { changed++; }).catch(() => { failed++; });
    }
  }

  return { changed, failed };
}

async function deleteGuildInvites(guild) {
  let deleted = 0;
  let failed = 0;

  try {
    const invites = await guild.invites.fetch();
    for (const [, invite] of invites) {
      await invite.delete('FenixExelent Emergency Mode').then(() => { deleted++; }).catch(() => { failed++; });
    }
  } catch {
    failed++;
  }

  return { deleted, failed };
}

async function enableEmergencyMode(guild, gc) {
  ensureSecurityStats(gc);
  await guild.channels.fetch().catch(() => {});

  if (!gc.emergency) gc.emergency = {};
  if (!gc.emergency.active) {
    gc.emergency.previous = {
      antispam: { ...gc.antispam },
      antiraid: { ...gc.antiraid },
      antiscam: { ...gc.antiscam },
    };
  }

  gc.emergency.active = true;
  gc.securityStats.emergencyActivations++;

  gc.antispam.enabled = true;
  gc.antispam.maxMessages = Math.min(gc.antispam.maxMessages || 5, 3);
  gc.antispam.interval = Math.min(gc.antispam.interval || 3000, 2500);
  gc.antispam.muteMinutes = Math.max(gc.antispam.muteMinutes || 10, 30);

  gc.antiraid.enabled = true;
  gc.antiraid.lockdownActive = true;
  gc.antiraid.joinThreshold = Math.min(gc.antiraid.joinThreshold || 10, 5);
  gc.antiraid.joinInterval = Math.min(gc.antiraid.joinInterval || 10000, 10000);

  gc.antiscam.enabled = true;
  gc.antiscam.deleteMessage = true;
  gc.antiscam.blockScamImages = true;
  gc.antiscam.ocrScamImages = true;
  gc.antiscam.blockImageOnlyScamScreenshots = true;

  const lockdown = await setGuildEmergencyLockdown(guild, true);

  // Bezpieczna wersja: Emergency Mode NIE usuwa zaproszeń.
  // Usuwanie invite linków potrafi zaskoczyć właścicieli serwerów i nie da się ich automatycznie odtworzyć.
  const invites = { deleted: 0, failed: 0, skipped: true };

  saveConfig();
  return { lockdown, invites };
}

async function disableEmergencyMode(guild, gc) {
  await guild.channels.fetch().catch(() => {});

  if (gc.emergency?.previous) {
    if (gc.emergency.previous.antispam) gc.antispam = Object.assign(gc.antispam, gc.emergency.previous.antispam);
    if (gc.emergency.previous.antiraid) gc.antiraid = Object.assign(gc.antiraid, gc.emergency.previous.antiraid);
    if (gc.emergency.previous.antiscam) gc.antiscam = Object.assign(gc.antiscam, gc.emergency.previous.antiscam);
  }

  if (!gc.emergency) gc.emergency = {};
  gc.emergency.active = false;
  gc.emergency.previous = null;
  if (gc.antiraid) gc.antiraid.lockdownActive = false;

  const lockdown = await setGuildEmergencyLockdown(guild, false);
  saveConfig();
  return { lockdown };
}


async function ensureVerificationForAntiAlt(guild, gc) {
  if (!gc.verification) {
    gc.verification = { enabled: false, roleId: null, unverifiedRoleId: null, channelId: null };
  }

  let createdSomething = false;

  let verifiedRole = gc.verification.roleId
    ? guild.roles.cache.get(gc.verification.roleId)
    : null;

  if (!verifiedRole) {
    verifiedRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'zweryfikowany' || r.name.toLowerCase() === 'verified');
  }

  if (!verifiedRole) {
    verifiedRole = await guild.roles.create({
      name: 'Zweryfikowany',
      colors: ('#22c55e') ? { primaryColor: ('#22c55e') } : undefined,
      reason: 'FenixExelent AntiAlt: automatyczny setup roli weryfikacji',
    }).catch(() => null);
    if (verifiedRole) createdSomething = true;
  }

  let unverifiedRole = gc.verification.unverifiedRoleId
    ? guild.roles.cache.get(gc.verification.unverifiedRoleId)
    : null;

  if (!unverifiedRole) {
    unverifiedRole = guild.roles.cache.find(r => r.name.toLowerCase() === 'niezweryfikowany' || r.name.toLowerCase() === 'unverified');
  }

  if (!unverifiedRole) {
    unverifiedRole = await guild.roles.create({
      name: 'Niezweryfikowany',
      colors: ('#747d8c') ? { primaryColor: ('#747d8c') } : undefined,
      reason: 'FenixExelent AntiAlt: automatyczny setup roli przed weryfikacją',
    }).catch(() => null);
    if (unverifiedRole) createdSomething = true;
  }

  if (verifiedRole) gc.verification.roleId = verifiedRole.id;
  if (unverifiedRole) gc.verification.unverifiedRoleId = unverifiedRole.id;
  gc.verification.enabled = true;

  let verifyChannel = gc.verification.channelId
    ? guild.channels.cache.get(gc.verification.channelId)
    : null;

  if (!verifyChannel) {
    const category = await getOrCreateCategory(guild, '🔐 WERYFIKACJA').catch(() => null);
    verifyChannel = guild.channels.cache.find(ch =>
      ch.type === ChannelType.GuildText &&
      ['✅│weryfikacja', 'weryfikacja', 'verification'].includes(String(ch.name || '').toLowerCase())
    );

    if (!verifyChannel) {
      verifyChannel = await guild.channels.create({
        name: '✅│weryfikacja',
        type: ChannelType.GuildText,
        parent: category?.id || null,
        reason: 'FenixExelent AntiAlt: automatyczny kanał weryfikacji',
      }).catch(() => null);
      if (verifyChannel) createdSomething = true;
    }

    if (verifyChannel) gc.verification.channelId = verifyChannel.id;
  }

  if (unverifiedRole) {
    await guild.channels.fetch().catch(() => {});
    for (const [, ch] of guild.channels.cache) {
      if (![ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory].includes(ch.type)) continue;

      if (verifyChannel && ch.id === verifyChannel.id) {
        await ch.permissionOverwrites.edit(unverifiedRole, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
        }).catch(() => {});
      } else {
        await ch.permissionOverwrites.edit(unverifiedRole, {
          ViewChannel: false,
        }).catch(() => {});
      }
    }
  }

  if (verifyChannel && createdSomething) {
    await sendVerifyPanel(verifyChannel).catch(() => {});
  }

  saveConfig();

  return {
    ok: !!(verifiedRole && unverifiedRole && verifyChannel),
    verifiedRole,
    unverifiedRole,
    verifyChannel,
    createdSomething,
  };
}


async function maybeHandleAntiAlt(member) {
  const gc = getGuildConfig(member.guild.id);
  if (!gc.antialt?.enabled) return;

  const minDays = Number(gc.antialt.minAccountAgeDays || 7);
  const ageDays = getAccountAgeDays(member.user);
  if (ageDays >= minDays) return;

  ensureSecurityStats(gc).altDetections++;
  addRisk(gc, member.id, Number(gc.antialt.riskPoints || 20), `Nowe konto Discord: ${ageDays}/${minDays} dni`, { type: 'antialt' });
  saveConfig();

  const action = gc.antialt.action || 'verify';
  if (action === 'ban' && member.bannable) {
    await member.ban({ reason: `FenixExelent AntiAlt: konto ma ${ageDays}/${minDays} dni` }).catch(() => {});
  } else if (action === 'kick' && member.kickable) {
    await member.kick(`FenixExelent AntiAlt: konto ma ${ageDays}/${minDays} dni`).catch(() => {});
  } else if (gc.verification?.unverifiedRoleId) {
    await member.roles.add(gc.verification.unverifiedRoleId, 'FenixExelent AntiAlt: nowe konto').catch(() => {});
  }

  await sendLog(member.guild, gc.antialt.logChannel || getBestLogChannelId(gc), embed(
    '#ffa502',
    '🆕 AntiAlt — nowe konto',
    `<@${member.id}> ma konto młodsze niż wymagany limit i wymaga dodatkowej weryfikacji.`,
    [
      { name: 'Użytkownik', value: `${member.user.tag} (${member.id})`, inline: true },
      { name: 'Wiek konta', value: `${ageDays} dni`, inline: true },
      { name: 'Minimum', value: `${minDays} dni`, inline: true },
      { name: 'Risk +', value: `${gc.antialt.riskPoints || 20}`, inline: true },
      { name: 'Akcja', value: action, inline: true },
    ]
  ));
}

function markRecentJoin(member) {
  recentJoinMap.set(`${member.guild.id}:${member.id}`, Date.now());
  setTimeout(() => recentJoinMap.delete(`${member.guild.id}:${member.id}`), 15 * 60 * 1000);
}

function maybeAddFastJoinRisk(message, gc) {
  const key = `${message.guild.id}:${message.author.id}`;
  const joinedAt = recentJoinMap.get(key);
  if (!joinedAt || fastJoinRiskGiven.has(key)) return;

  if (Date.now() - joinedAt <= 5 * 60 * 1000) {
    fastJoinRiskGiven.add(key);
    addRisk(gc, message.author.id, 5, 'Szybkie pisanie zaraz po dołączeniu do serwera', { type: 'fast-join-message' });
    saveConfig();
    setTimeout(() => fastJoinRiskGiven.delete(key), 60 * 60 * 1000);
  }
}


function ensureArrayConfig(obj, key) {
  if (!obj[key] || !Array.isArray(obj[key])) obj[key] = [];
  obj[key] = [...new Set(obj[key].filter(Boolean))];
  return obj[key];
}

function ensureSecurityIgnore(gc) {
  if (!gc.securityIgnore) gc.securityIgnore = { channels: [], roles: [] };
  ensureArrayConfig(gc.securityIgnore, 'channels');
  ensureArrayConfig(gc.securityIgnore, 'roles');
  return gc.securityIgnore;
}

function isSecurityIgnoredMessage(message, gc) {
  const ignore = ensureSecurityIgnore(gc);
  if (ignore.channels.includes(message.channel?.id)) return true;
  const member = message.member;
  if (member && ignore.roles.some(roleId => member.roles.cache.has(roleId))) return true;
  return false;
}

function makeBackupId() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `backup-${stamp}`;
}

function snapshotGuildConfig(gc) {
  return JSON.parse(JSON.stringify({
    antispam: gc.antispam,
    antiraid: gc.antiraid,
    antiscam: gc.antiscam,
    antialt: gc.antialt,
    channelGuard: gc.channelGuard,
    verification: gc.verification,
    tickets: gc.tickets,
    modLog: gc.modLog,
    securityIgnore: gc.securityIgnore,
    appeals: gc.appeals,
  }));
}

function createServerBackup(guild, gc) {
  const id = makeBackupId();
  if (!gc.backups) gc.backups = {};

  const roles = guild.roles.cache
    .filter(role => !role.managed && role.id !== guild.roles.everyone.id)
    .map(role => ({
      name: role.name,
      color: role.hexColor,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
    }))
    .sort((a, b) => a.position - b.position);

  const channels = guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildCategory || ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice)
    .map(ch => ({
      name: ch.name,
      type: ch.type,
      parentName: ch.parent?.name || null,
      topic: ch.topic || null,
      nsfw: !!ch.nsfw,
      position: ch.position || 0,
    }))
    .sort((a, b) => a.position - b.position);

  gc.backups[id] = {
    id,
    createdAt: new Date().toISOString(),
    guildName: guild.name,
    roles,
    channels,
    config: snapshotGuildConfig(gc),
  };

  const keys = Object.keys(gc.backups).sort((a, b) => String(gc.backups[b].createdAt).localeCompare(String(gc.backups[a].createdAt)));
  for (const oldKey of keys.slice(10)) delete gc.backups[oldKey];

  ensureSecurityStats(gc).backupsCreated++;
  saveConfig();
  return gc.backups[id];
}

async function restoreServerBackup(guild, gc, backupId) {
  const backup = gc.backups?.[backupId];
  if (!backup) return null;

  let rolesCreated = 0;
  let channelsCreated = 0;
  let failed = 0;

  for (const r of backup.roles || []) {
    if (!guild.roles.cache.find(role => role.name === r.name)) {
      await guild.roles.create({
        name: r.name,
        colors: (/^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : undefined) ? { primaryColor: (/^#[0-9a-f]{6}$/i.test(r.color || '') ? r.color : undefined) } : undefined,
        hoist: !!r.hoist,
        mentionable: !!r.mentionable,
        permissions: BigInt(r.permissions || '0'),
        reason: `FenixExelent backup restore ${backupId}`,
      }).then(() => rolesCreated++).catch(() => failed++);
    }
  }

  const categories = (backup.channels || []).filter(ch => ch.type === ChannelType.GuildCategory);
  const others = (backup.channels || []).filter(ch => ch.type !== ChannelType.GuildCategory);

  for (const c of categories) {
    if (!guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === c.name)) {
      await guild.channels.create({ name: c.name, type: ChannelType.GuildCategory, reason: `FenixExelent backup restore ${backupId}` })
        .then(() => channelsCreated++)
        .catch(() => failed++);
    }
  }

  await guild.channels.fetch().catch(() => {});

  for (const c of others) {
    const exists = guild.channels.cache.find(ch => ch.type === c.type && ch.name === c.name && (ch.parent?.name || null) === (c.parentName || null));
    if (exists) continue;
    const parent = c.parentName ? guild.channels.cache.find(ch => ch.type === ChannelType.GuildCategory && ch.name === c.parentName) : null;
    await guild.channels.create({
      name: c.name,
      type: c.type,
      parent: parent?.id || null,
      topic: c.type === ChannelType.GuildText ? c.topic || undefined : undefined,
      nsfw: c.type === ChannelType.GuildText ? !!c.nsfw : undefined,
      reason: `FenixExelent backup restore ${backupId}`,
    }).then(() => channelsCreated++).catch(() => failed++);
  }

  if (backup.config && typeof backup.config === 'object') {
    for (const [key, value] of Object.entries(backup.config)) {
      gc[key] = JSON.parse(JSON.stringify(value));
    }
    saveConfig();
  }

  return { backupId: backup.id, rolesCreated, channelsCreated, failed, configRestored: !!backup.config };
}

function calculateServerSecurityScore(gc) {
  const checks = [];
  const add = (label, ok, points, warn = '') => checks.push({ label, ok, points, warn });

  add('AntiScam włączony', !!gc.antiscam?.enabled, 15);
  add('OCR screenów scam włączony', !!gc.antiscam?.ocrScamImages, 10);
  add('AntiSpam włączony', !!gc.antispam?.enabled, 12);
  add('AntiRaid włączony', !!gc.antiraid?.enabled, 12);
  add('AntiAlt włączony', !!gc.antialt?.enabled, 10);
  add('Weryfikacja włączona', !!gc.verification?.enabled, 10);
  add('Logi moderacji ustawione', !!gc.modLog?.channelId, 8);
  add('Logi AntiScam ustawione', !!gc.antiscam?.logChannel, 8);
  add('Tryb awaryjny dostępny', !!gc.emergency, 5);
  add('System zgłoszeń/appeali gotowy', !!gc.appeals, 5);
  add('Ignorowane kanały/role skonfigurowane', !!(gc.securityIgnore?.channels?.length || gc.securityIgnore?.roles?.length), 5);

  const score = Math.min(100, checks.reduce((sum, c) => sum + (c.ok ? c.points : 0), 0));
  return { score, checks };
}

function makeAppealId() {
  return `appeal-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function ensureAppeals(gc) {
  if (!gc.appeals) gc.appeals = { enabled: true, channelId: null, cases: {} };
  if (!gc.appeals.cases) gc.appeals.cases = {};
  return gc.appeals;
}

function buildAppealButtons(appealId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal:accept:${appealId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appeal:reject:${appealId}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`appeal:more:${appealId}`).setLabel('📝 More info').setStyle(ButtonStyle.Secondary),
  )];
}

function buildDisabledAppealButtons(appealId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal:accept:${appealId}`).setLabel('✅ Accept').setStyle(ButtonStyle.Success).setDisabled(true),
    new ButtonBuilder().setCustomId(`appeal:reject:${appealId}`).setLabel('❌ Reject').setStyle(ButtonStyle.Danger).setDisabled(true),
    new ButtonBuilder().setCustomId(`appeal:more:${appealId}`).setLabel('📝 More info').setStyle(ButtonStyle.Secondary).setDisabled(true),
  )];
}

function policyHtml(kind) {
  const baseUrl = config.dashboardUrl || 'https://fenixexelent.onrender.com';
  const isPrivacy = kind === 'privacy';
  const title = isPrivacy ? 'Privacy Policy' : kind === 'terms' ? 'Terms of Service' : kind === 'support' ? 'Support' : 'About FenixExelentSecurity';
  const body = isPrivacy ? `
    <p>FenixExelentSecurity processes Discord server data only to provide moderation, security, AntiSpam, AntiRaid, AntiScam, OCR screenshot scanning, tickets, verification, logs and dashboard features.</p>
    <p>The bot may process message content, links, domains, attachment metadata, OCR text from images, user IDs, server IDs, role/channel IDs, moderation actions and configuration settings.</p>
    <p>Data is not sold. Server owners can remove bot data by removing the bot and asking support for deletion.</p>
    <p>Do not send secrets or private tokens in public Discord channels.</p>` : kind === 'terms' ? `
    <p>By using FenixExelentSecurity, server owners agree to use the bot for lawful moderation and security purposes.</p>
    <p>The bot may delete messages, timeout users, lock channels and log security events according to the server configuration.</p>
    <p>Administrators are responsible for configuring permissions and reviewing automated actions.</p>
    <p>The service is provided as-is and may change as security features improve.</p>` : kind === 'support' ? `
    <p>Need help? Use the support server or dashboard links below.</p>
    <p><a href="${baseUrl}/invite">Invite the bot</a> · <a href="${baseUrl}/dashboard.html">Dashboard</a> · <a href="${baseUrl}/public-status">Public Status</a></p>` : `
    <p>FenixExelentSecurity is a Discord security bot focused on AntiScam, AntiRaid, AntiSpam, OCR screenshot scanning, AntiAlt protection, tickets, verification, reports, appeals, backups and emergency lockdown.</p>
    <p><a href="${baseUrl}/invite">Invite FenixExelentSecurity</a> · <a href="${baseUrl}/dashboard.html">Open Dashboard</a></p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#050712;color:#f8fbff;font-family:Arial,sans-serif}main{max-width:900px;margin:0 auto;padding:36px}.card{background:#0d1428;border:1px solid rgba(96,165,250,.25);border-radius:24px;padding:28px}a{color:#60a5fa}h1{color:#f59e0b}.muted{color:#9fb0d0}</style></head><body><main><div class="card"><h1>${title}</h1>${body}<p class="muted">Last updated: ${new Date().toISOString().slice(0,10)}</p></div></main></body></html>`;
}

async function getOrCreateCategory(guild, name) {
  return guild.channels.cache.find(c =>
    c.type === ChannelType.GuildCategory && c.name === name
  ) || await guild.channels.create({ name, type: ChannelType.GuildCategory });
}

async function getOrCreateVoice(guild, category, name, permissionOverwrites) {
  return guild.channels.cache.find(c =>
    c.type === ChannelType.GuildVoice && c.name === name && c.parentId === category.id
  ) || await guild.channels.create({ name, type: ChannelType.GuildVoice, parent: category, permissionOverwrites });
}

async function getOrCreateText(guild, category, name, permissionOverwrites) {
  return guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText && c.name === name && c.parentId === category.id
  ) || await guild.channels.create({ name, type: ChannelType.GuildText, parent: category, permissionOverwrites });
}


// ─── STATS UPDATE ──────────────────────────────────────────────────────────
async function updateStats(guild) {
  const gc = getGuildConfig(guild.id);
  const s  = gc.setup;
  if (!s.statsMembersId && !s.statsBotsId && !s.statsTotalId) return;
  await guild.members.fetch().catch(() => {});
  const members = guild.members.cache.filter(m => !m.user.bot).size;
  const bots    = guild.members.cache.filter(m =>  m.user.bot).size;
  const total   = guild.memberCount;
  const chM = guild.channels.cache.get(s.statsMembersId);
  const chB = guild.channels.cache.get(s.statsBotsId);
  const chT = guild.channels.cache.get(s.statsTotalId);
  if (chM) await chM.edit({ name: `👥 Członkowie: ${members}` }).catch(() => {});
  if (chB) await chB.edit({ name: `🤖 Boty: ${bots}` }).catch(() => {});
  if (chT) await chT.edit({ name: `🌐 Razem: ${total}` }).catch(() => {});
}

// Odświeżaj statystyki co 10 minut
setInterval(() => {
  client.guilds.cache.forEach(g => updateStats(g).catch(() => {}));
}, 10 * 60 * 1000);


// ─── REACTION ROLES: STEAM + PLATFORMA ───────────────────────────────────
const REACTION_ROLE_DEFINITIONS = [
  { emoji: '🖥️', name: 'PC', color: '#5865F2', group: 'Platforma' },
  { emoji: '🎮', name: 'Steam Deck', color: '#1B2838', group: 'Platforma' },

  { emoji: '💣', name: 'Counter-Strike 2', color: '#F1C40F', group: 'Steam online' },
  { emoji: '🔮', name: 'Dota 2', color: '#C0392B', group: 'Steam online' },
  { emoji: '🪂', name: 'PUBG: BATTLEGROUNDS', color: '#E67E22', group: 'Steam online' },
  { emoji: '🤖', name: 'Apex Legends', color: '#D35400', group: 'Steam online' },
  { emoji: '🛡️', name: 'Rainbow Six Siege', color: '#3498DB', group: 'Steam online' },

  { emoji: '🛠️', name: 'Rust', color: '#A04000', group: 'Steam survival/co-op' },
  { emoji: '🦖', name: 'ARK: Survival Ascended', color: '#16A085', group: 'Steam survival/co-op' },
  { emoji: '🔪', name: 'Dead by Daylight', color: '#7F8C8D', group: 'Steam survival/co-op' },
  { emoji: '👾', name: 'Helldivers 2', color: '#F4D03F', group: 'Steam survival/co-op' },
  { emoji: '🌀', name: 'Warframe', color: '#5DADE2', group: 'Steam survival/co-op' },

  { emoji: '🚗', name: 'Grand Theft Auto V', color: '#2ECC71', group: 'Steam RPG/sim' },
  { emoji: '🌃', name: 'Cyberpunk 2077', color: '#F1C40F', group: 'Steam RPG/sim' },
  { emoji: '🐉', name: "Baldur's Gate 3", color: '#8E6E53', group: 'Steam RPG/sim' },
  { emoji: '🚚', name: 'Euro Truck Simulator 2', color: '#2980B9', group: 'Steam RPG/sim' },
  { emoji: '🌾', name: 'Stardew Valley', color: '#58D68D', group: 'Steam RPG/sim' },
  { emoji: '⛏️', name: 'Terraria', color: '#6AA84F', group: 'Steam RPG/sim' },
];

function ensureReactionRolesConfig(gc) {
  if (!gc.reactionRoles) {
    gc.reactionRoles = {
      enabled: false,
      channelId: null,
      messageId: null,
      roleMap: {},
    };
  }
  if (!gc.reactionRoles.roleMap || typeof gc.reactionRoles.roleMap !== 'object') {
    gc.reactionRoles.roleMap = {};
  }
  return gc.reactionRoles;
}

function normalizeReactionEmoji(value) {
  return String(value || '').replace(/\uFE0F/g, '');
}

function canManageReactionRoles(message) {
  if (!message.guild || !message.member) return false;
  return (
    message.guild.ownerId === message.author.id ||
    message.member.permissions.has(PermissionFlagsBits.Administrator) ||
    message.member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

async function createReactionRolesPanel(message) {
  const guild = message.guild;
  const gc = getGuildConfig(guild.id);
  const cfg = ensureReactionRolesConfig(gc);

  await guild.roles.fetch().catch(() => {});

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return message.reply('❌ Bot potrzebuje uprawnienia **Zarządzanie rolami**. Najprościej nadaj mu Administratora na czas konfiguracji.');
  }

  const roleMap = {};
  const created = [];
  const reused = [];

  for (const def of REACTION_ROLE_DEFINITIONS) {
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === def.name.toLowerCase());
    if (!role) {
      role = await guild.roles.create({
        name: def.name,
        colors: (def.color) ? { primaryColor: (def.color) } : undefined,
        mentionable: false,
        reason: `FenixExelent reaction roles: ${def.name}`,
      }).catch(() => null);
      if (role) created.push(role.name);
    } else {
      reused.push(role.name);
    }

    if (role) roleMap[normalizeReactionEmoji(def.emoji)] = role.id;
  }

  const platformLines = REACTION_ROLE_DEFINITIONS
    .filter(d => d.group === 'Platforma')
    .map(d => `${d.emoji} — **${d.name}**`)
    .join('\n');
  const onlineLines = REACTION_ROLE_DEFINITIONS
    .filter(d => d.group === 'Steam online')
    .map(d => `${d.emoji} — **${d.name}**`)
    .join('\n');
  const survivalLines = REACTION_ROLE_DEFINITIONS
    .filter(d => d.group === 'Steam survival/co-op')
    .map(d => `${d.emoji} — **${d.name}**`)
    .join('\n');
  const rpgSimLines = REACTION_ROLE_DEFINITIONS
    .filter(d => d.group === 'Steam RPG/sim')
    .map(d => `${d.emoji} — **${d.name}**`)
    .join('\n');

  const panel = await message.channel.send({
    embeds: [embed(
      '#5865F2',
      '🎮 Wybierz swoje role Steam',
      'Kliknij reakcję pod wiadomością, aby dostać rolę. Usuń swoją reakcję, aby rola została zabrana.',
      [
        { name: '🕹️ Platforma', value: platformLines, inline: false },
        { name: '🔥 Steam — gry online', value: onlineLines, inline: false },
        { name: '🧟 Steam — survival i co-op', value: survivalLines, inline: false },
        { name: '🧙 Steam — RPG i symulatory', value: rpgSimLines, inline: false },
      ]
    )],
  }).catch(() => null);

  if (!panel) {
    return message.reply('❌ Nie udało się wysłać panelu. Sprawdź uprawnienia: Wyświetlanie kanału, Wysyłanie wiadomości i Osadzanie linków.');
  }

  for (const def of REACTION_ROLE_DEFINITIONS) {
    if (!roleMap[normalizeReactionEmoji(def.emoji)]) continue;
    await panel.react(def.emoji).catch(() => {});
  }

  cfg.enabled = true;
  cfg.channelId = message.channel.id;
  cfg.messageId = panel.id;
  cfg.roleMap = roleMap;
  cfg.updatedAt = new Date().toISOString();
  saveConfig();

  await message.reply(
    `✅ Panel ról został utworzony. Utworzono: **${created.length}**, użyto istniejących: **${reused.length}**.\n` +
    'Użytkownicy mogą wybrać kilka gier oraz platformę PC lub Steam Deck.'
  ).catch(() => {});
}

async function createReactionRolesPanelForChannel(channel) {
  let responseText = '';
  await createReactionRolesPanel({
    guild: channel.guild,
    channel,
    reply: async value => {
      responseText = typeof value === 'string' ? value : String(value?.content || '');
      return null;
    },
  });
  if (responseText.startsWith('❌')) throw new Error(responseText.replace(/^❌\s*/, ''));
  const cfg = ensureReactionRolesConfig(getGuildConfig(channel.guild.id));
  return { enabled: cfg.enabled, channelId: cfg.channelId, messageId: cfg.messageId, response: responseText };
}

// Komenda tekstowa — bez deploy-commands.js.
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const command = String(message.content || '').trim().toLowerCase();
  const aliases = {
    '!role setup': '!rolepanel setup',
    '!role status': '!rolepanel status',
    '!role off': '!rolepanel off',
  };
  const resolvedCommand = aliases[command] || command;
  if (!['!rolepanel setup', '!rolepanel status', '!rolepanel off'].includes(resolvedCommand)) return;

  if (!canManageReactionRoles(message)) {
    return message.reply('❌ Tej komendy może użyć tylko właściciel serwera lub administrator.').catch(() => {});
  }

  const gc = getGuildConfig(message.guild.id);
  const cfg = ensureReactionRolesConfig(gc);

  if (resolvedCommand === '!rolepanel setup') {
    return createReactionRolesPanel(message);
  }

  if (resolvedCommand === '!rolepanel status') {
    const status = cfg.enabled ? '✅ Włączony' : '❌ Wyłączony';
    const panel = cfg.messageId && cfg.channelId
      ? `https://discord.com/channels/${message.guild.id}/${cfg.channelId}/${cfg.messageId}`
      : 'Brak panelu';
    return message.reply(`**Reaction Roles:** ${status}\n**Panel:** ${panel}`).catch(() => {});
  }

  cfg.enabled = false;
  saveConfig();
  return message.reply('✅ Automatyczne role przez reakcje zostały wyłączone. Role i panel nie zostały usunięte.').catch(() => {});
});

async function resolveReactionData(reaction, user) {
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
    if (user?.partial) await user.fetch();
  } catch {
    return null;
  }

  const guild = reaction.message?.guild;
  if (!guild || !user || user.bot) return null;

  const gc = getGuildConfig(guild.id);
  const cfg = ensureReactionRolesConfig(gc);
  if (!cfg.enabled || reaction.message.id !== cfg.messageId) return null;

  const emojiKey = normalizeReactionEmoji(reaction.emoji?.name);
  const roleId = cfg.roleMap?.[emojiKey];
  if (!roleId) return null;

  const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!role || !member) return null;

  return { guild, role, member };
}

client.on('messageReactionAdd', async (reaction, user) => {
  const data = await resolveReactionData(reaction, user);
  if (!data) return;
  await data.member.roles.add(data.role, 'FenixExelent: rola wybrana reakcją').catch(err => {
    logger.warn(`ReactionRoles add error: ${err.message || err}`);
  });
});

client.on('messageReactionRemove', async (reaction, user) => {
  const data = await resolveReactionData(reaction, user);
  if (!data) return;
  await data.member.roles.remove(data.role, 'FenixExelent: usunięto reakcję').catch(err => {
    logger.warn(`ReactionRoles remove error: ${err.message || err}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  BOT EVENTS
// ═══════════════════════════════════════════════════════════════════════════

function updateBotPresence() {
  if (!client.isReady()) return;

  const guildCount = client.guilds.cache.size;

  client.user.setPresence({
    activities: [
      {
        name: `${guildCount} serwerów | /help`,
      },
    ],
    status: 'online',
  });

  logger.info(`🔄 Status bota zaktualizowany: ${guildCount} serwerów`);
}

client.once('clientReady', async () => {
  logger.info(`🔥 FenixExelent online jako ${client.user.tag}`);
  logger.info(`📊 Serwery: ${client.guilds.cache.size}`);

  updateBotPresence();

  for (const [, guild] of client.guilds.cache) {
    await updateStats(guild).catch(() => {});
  }

});

client.on('guildCreate', async (guild) => {
  logger.info(`✅ Bot dodany na serwer: ${guild.name} (${guild.id})`);
  updateBotPresence();
  await updateStats(guild).catch(() => {});

  try {
    const owner = await guild.fetchOwner().catch(() => null);
    if (owner) {
      await owner.send({ embeds: [embed(
        '#ff6b00',
        '🔥 FenixExelentSecurity — szybki start',
        `Dzięki za dodanie bota na **${guild.name}**.\n\n` +
        '1. Użyj `/setup`\n' +
        '2. Ustaw `/modlog` oraz `/antiscam log`\n' +
        '3. Włącz `/antiscam on`, `/ocrscan on`, `/antialt on`\n' +
        '4. Sprawdź `/servercheck`\n' +
        '5. Otwórz dashboard: ' + config.dashboardUrl + '\n\n' +
        'W razie raidu użyj `/emergency on`.'
      )] }).catch(() => {});
    }
  } catch {}
});

client.on('guildDelete', async (guild) => {
  logger.info(`❌ Bot usunięty z serwera: ${guild.name} (${guild.id})`);
  updateBotPresence();
});

setInterval(() => {
  updateBotPresence();
}, 5 * 60 * 1000);


client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const gc = getGuildConfig(message.guild.id);
  maybeAddFastJoinRisk(message, gc);
});

// ─── ANTISCAM ──────────────────────────────────────────────────────────────
function extractDomains(text) {
  const domainRegex = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s<]*)?/gi;
  const domains = [];
  let match;

  while ((match = domainRegex.exec(String(text || ''))) !== null) {
    const domain = normalizeDomainInput(match[1]);
    if (domain && !domains.includes(domain)) domains.push(domain);
  }

  return domains;
}

const DEFAULT_BLOCKED_DOMAINS = [
  // IP loggery / trackery
  'grabify.link',
  'iplogger.org',
  'iplogger.com',
  'iplogger.co',
  'iplogger.info',
  '2no.co',
  'yip.su',
  'bmwforum.co',
  'blasze.com',
  'blasze.pl',
  'gyazo.nl',
  'gyazo.cc',
  'leancoding.co',

  // Discord / Nitro scam
  'discord-nitro.xyz',
  'discordgift.xyz',
  'discord-gift.xyz',
  'discordnitro.xyz',
  'discord-free.xyz',
  'discord-event.xyz',
  'discordnitro.net',
  'discordgift.net',
  'discord-gifts.net',
  'nitro-discord.net',
  'discord-event.net',
  'discordbonus.net',
  'nitro-event.xyz',
  'nitrofree.xyz',
  'nitrobonus.xyz',
  'free-nitro.xyz',
  'free-discordnitro.xyz',
  'claim-nitro.xyz',
  'discordnitro.click',
  'discordgift.click',
  'discordnitro.top',
  'discordgift.site',
  'nitro.site',
  'discord-event.online',
  'discord-airdrop.win',
  'nitro.win',
  'discordgift.work',
  'fake-nitro.xyz',

  // Fake support / verification
  'discord-security.xyz',
  'discord-support.xyz',
  'discordverify.xyz',
  'discord-support.net',
  'discord-security.net',
  'discordstaff.net',
  'discord-verify.net',

  // Steam scam
  'steam-gift.xyz',
  'steambonus.xyz',
  'steamreward.xyz',
  'steam-drop.xyz',
  'steamgift.click',
  'steamgift.top',
  'steam-event.online',
  'steamgift.work',
  'steamcommunity.work',
  'steamcommunity.one',
  'steamcommunity.click',
  'steamcommunity.vip',
  'steamcommunnity.com',
  'steamcornmunity.com',
  'stearncommunity.com',
  'steam-security.xyz',
  'steamverify.xyz',
  'steam-support.net',
  'steam-security.net',

  // Crypto scam
  'crypto-airdrop.xyz',
  'bitcoin-giveaway.xyz',
  'eth-airdrop.xyz',
  'bitcoin-giveaway.net',
  'bitcoin-bonus.net',
  'bitcoin-drop.net',
  'eth-giveaway.net',
  'ethbonus.net',
  'crypto-reward.net',
  'crypto-airdrop.net',
  'claim-airdrop.net',

  // Rewards / gift scam
  'epicgift.xyz',
  'epic-reward.xyz',
  'claim-reward.xyz',

  // CS2 / skins scam
  'csgo-skins.net',
  'cs2reward.net',
  'skinbonus.net',
  'skins-drop.net',
  'free-skins.net',

  // Crypto / casino scam z reklam i fałszywych wypłat
  'buzzium.com',
  'buzziun.com',
  'tornavlin.com',
  'tornawlin.com',
  'fomavlin.com',
  'fomnvlin.com',
  'formavlin.com',
  'formnvlin.com',
  'buzzium.net',
  'buzzium.org',
  'tornavlin.net',
  'tornavlin.org',
  'fomavlin.net',
  'fomavlin.org',
  'beast-casino.com',
  'mrbeast-casino.com',
  'mrbeast-bonus.com',
  'beast-bonus.com',
  'free-usdt.com',
  'claim-usdt.com',
  'usdt-reward.com',
  'crypto-bonus.com',
  'wallet-bonus.com',

  // Typosquatting
  'disc0rd.com',
  'd1scord.com',
  'dlscord.com',
  'discordapp.net',
  'discordgift.com',
  'discordnitro.com',
];

const SUSPICIOUS_TLDS = [
  'xyz',
  'click',
  'top',
  'work',
  'win',
  'gift',
  'vip',
  'site',
  'online',
  'icu',
  'shop',
  'store',
  'app',
  'pro',
  'lol',
  'fun',
  'quest',
  'cyou',
  'website',
  'rest',
  'buzz'
];

const SUSPICIOUS_KEYWORDS = [
  'discord',
  'nitro',
  'steam',
  'gift',
  'reward',
  'bonus',
  'claim',
  'airdrop',
  'crypto',
  'wallet',
  'withdraw',
  'withdrawal',
  'tether',
  'usdt',
  'bitcoin',
  'btc',
  'eth',
  'casino',
  'bet',
  'win',
  'bonus',
  'promo',
  'code'
];

// Frazy typowe dla scamów ze screena: fałszywe wypłaty, bonusy, kody promocyjne, kasyno/crypto.
// Bot nadal wymaga linku w wiadomości — nie usuwa zwykłych rozmów bez domeny.
const CRYPTO_SCAM_TEXT_PATTERNS = [
  /withdrawal\s+success/i,
  /your\s+withdrawal\s+of/i,
  /\bwithdraw(?:al)?\b/i,
  /\b(?:usdt|tether|crypto|bitcoin|btc|ethereum|eth|wallet)\b/i,
  /\b(?:bonus|promo\s*code|lucky\s*code|claim|reward|receive|airdrop|giveaway|prize)\b/i,
  /\b(?:casino|bet|slots?|gambling|jackpot)\b/i,
  /\$\s?\d{3,}/i,
  /\b\d{3,}\s?(?:usdt|usd|btc|eth)\b/i,
  /\b(?:connect\s+wallet|wallet\s+address|enter\s+(?:the\s+)?(?:special\s+)?(?:promo\s+)?code)\b/i,
  /\b(?:register|sign\s*up|deposit)\b.*\b(?:bonus|promo|code|usdt|crypto)\b/i,
  /\b(?:mr\s*beast|beast\s*games?)\b.*\b(?:casino|bonus|crypto|usdt|withdraw|promo)\b/i,
  /\b(?:one\s+of\s+my\s+followers|congratulations|you\s+won)\b/i
];

const SAFE_DOMAINS = [
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'youtube.com',
  'youtu.be',
  'twitch.tv',
  'github.com',
  'google.com',
  'reddit.com',
  'x.com',
  'twitter.com'
];

function isSafeDomain(domain) {
  const clean = normalizeDomainInput(domain);
  return SAFE_DOMAINS.some(safe => clean === safe || clean.endsWith(`.${safe}`));
}

function isWhitelistedDomain(domain, gc = null) {
  const clean = normalizeDomainInput(domain);
  const extra = normalizeBlockedDomains(gc?.antiscam?.whitelistedDomains || []);
  return isSafeDomain(clean) || extra.some(safe => domainMatches(clean, safe));
}

function getCryptoScamScore(text = '') {
  const value = String(text || '');
  return CRYPTO_SCAM_TEXT_PATTERNS.reduce((score, pattern) => {
    return score + (pattern.test(value) ? 1 : 0);
  }, 0);
}

function normalizeDomainInput(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .split('#')[0]
    .replace(/^•+/, '')
    .replace(/^[^a-z0-9]+|[^a-z0-9.\-]+$/g, '')
    .trim();
}

function normalizeBlockedDomains(domains = []) {
  const output = [];

  for (const entry of domains) {
    const parts = String(entry || '')
      .split(/[\s,\n]+/)
      .map(normalizeDomainInput)
      .filter(Boolean)
      .filter(d => d.includes('.'))
      .filter(d => !d.startsWith('.'));

    for (const domain of parts) {
      if (!output.includes(domain)) output.push(domain);
    }
  }

  return output;
}

function isSuspiciousDomain(domain, messageText = '') {
  const clean = normalizeDomainInput(domain);
  const tld = clean.split('.').pop();
  const hasBadKeyword = SUSPICIOUS_KEYWORDS.some(word => clean.includes(word));
  const scamScore = getCryptoScamScore(messageText);

  if (isSafeDomain(clean)) return false;

  return (
    // np. crypto-bonus.xyz, claim-reward.click
    (SUSPICIOUS_TLDS.includes(tld) && hasBadKeyword) ||

    // np. domena z nazwą casino/bonus/wallet + tekst o USDT, wypłacie lub kodzie promocyjnym
    (hasBadKeyword && scamScore >= 2) ||

    // nawet neutralnie wyglądająca nowa domena, jeśli wiadomość wygląda jak scam crypto/kasyno
    (scamScore >= 4)
  );
}

function domainMatches(domain, rule) {
  const clean = normalizeDomainInput(domain);
  const target = normalizeDomainInput(rule);
  return clean === target || clean.endsWith(`.${target}`);
}

function isBlockedDomain(domain, blockedDomains = DEFAULT_BLOCKED_DOMAINS) {
  const clean = normalizeDomainInput(domain);
  return blockedDomains.some(blocked => domainMatches(clean, blocked));
}

function isImageAttachment(att) {
  const contentType = String(att.contentType || '').toLowerCase();
  const name = String(att.name || att.url || '').toLowerCase().split('?')[0];

  return (
    contentType.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)
  );
}

function hasImageAttachment(message) {
  return message.attachments?.some(isImageAttachment);
}

function getAttachmentNames(message) {
  return [...message.attachments.values()]
    .filter(isImageAttachment)
    .map(a => a.name || a.url || 'obraz')
    .slice(0, 5)
    .join(', ');
}

function isScamReportChannel(channel) {
  const name = String(channel?.name || '').toLowerCase();

  return (
    name.includes('zgłoszenia-scam') ||
    name.includes('zgloszenia-scam') ||
    name.includes('scam-domain') ||
    name.includes('analiza-link') ||
    name.includes('report-scam') ||
    name.includes('scam-report')
  );
}

function cleanOcrText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[|{}[\]<>]/g, ' ')
    .trim();
}

async function recognizeTextFromImage(att, gc) {
  if (!Tesseract) {
    return { text: '', error: 'tesseract.js nie jest zainstalowany' };
  }

  const maxBytes = gc.antiscam?.ocrMaxImageBytes || (8 * 1024 * 1024);
  if (att.size && att.size > maxBytes) {
    return { text: '', error: `obraz jest za duży (${att.size} B)` };
  }

  const imageUrl = att.url || att.proxyURL;
  if (!imageUrl) return { text: '', error: 'brak URL obrazka' };

  const timeoutMs = gc.antiscam?.ocrTimeoutMs || 25000;

  try {
    const result = await Promise.race([
      Tesseract.recognize(imageUrl, 'eng'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), timeoutMs))
    ]);

    return {
      text: cleanOcrText(result?.data?.text || ''),
      confidence: Math.round(result?.data?.confidence || 0),
    };
  } catch (err) {
    return { text: '', error: err.message || String(err) };
  }
}

async function scanImagesWithOcr(message, gc, blockedDomains) {
  if (!gc.antiscam?.ocrScamImages) return null;
  if (!hasImageAttachment(message)) return null;

  const images = [...message.attachments.values()]
    .filter(isImageAttachment)
    .slice(0, gc.antiscam?.ocrMaxImages || 2);

  for (const att of images) {
    const ocr = await recognizeTextFromImage(att, gc);
    const ocrText = ocr.text || '';

    if (!ocrText) {
      if (ocr.error) logger.warn(`OCR skipped/error for ${att.name || att.url}: ${ocr.error}`);
      continue;
    }

    const domains = extractDomains(ocrText);
    const foundDomain = domains.find(domain =>
      !isWhitelistedDomain(domain, gc) &&
      (isBlockedDomain(domain, blockedDomains) || isSuspiciousDomain(domain, ocrText))
    );

    if (foundDomain) {
      return {
        type: 'ocr+domain',
        value: foundDomain,
        reason: 'OCR wykrył domenę/link scam na screenie.',
        ocrText,
        ocrConfidence: ocr.confidence,
      };
    }

    const ocrScore = getCryptoScamScore(ocrText);
    const minScore = gc.antiscam?.ocrMinScamScore || 3;

    if (ocrScore >= minScore) {
      return {
        type: 'ocr+scam-image',
        value: att.name || 'screen scam',
        reason: `OCR wykrył tekst typowy dla crypto/casino scam na screenie. Score: ${ocrScore}/${minScore}.`,
        ocrText,
        ocrConfidence: ocr.confidence,
      };
    }
  }

  return null;
}


async function scanMessageForScam(message, gc) {
  const text = String(message.content || '');

  // Na kanałach zgłoszeń pozwalamy wysyłać scam linki/screeny do analizy,
  // aby bot nie karał osób zgłaszających oszustwo.
  const allowReportChannel = gc.antiscam?.allowScamReportsInReportChannels !== false;
  if (allowReportChannel && isScamReportChannel(message.channel)) {
    return null;
  }

  const domains = extractDomains(text);
  const blocked = normalizeBlockedDomains([
    ...DEFAULT_BLOCKED_DOMAINS,
    ...(gc.antiscam?.blockedDomains || []),
  ]);

  if (gc.antiscam) gc.antiscam.blockedDomains = blocked;

  const foundDomain = domains.find(domain =>
    !isWhitelistedDomain(domain, gc) &&
    (isBlockedDomain(domain, blocked) || isSuspiciousDomain(domain, text))
  );

  if (foundDomain) {
    return {
      type: 'domain',
      value: foundDomain,
      reason: isBlockedDomain(foundDomain, blocked)
        ? 'Domena jest na liście blokowanych domen.'
        : 'Podejrzana domena pasuje do wzorca scam/crypto/casino.',
    };
  }

  const scamScore = getCryptoScamScore(text);

  if (domains.length && scamScore >= 3) {
    const nonTrusted = domains.find(domain => !isWhitelistedDomain(domain, gc));
    if (nonTrusted) {
      return {
        type: 'text+domain',
        value: nonTrusted,
        reason: 'Wiadomość z linkiem zawiera tekst typowy dla crypto/casino scam.',
      };
    }
  }

  if (gc.antiscam?.blockScamImages && hasImageAttachment(message)) {
    if (text.trim() && scamScore >= 2) {
      return {
        type: 'image+scam-text',
        value: getAttachmentNames(message) || 'screen scam',
        reason: 'Obraz/screen wysłany z opisem typowym dla crypto/casino scam.',
      };
    }

    const ocrScam = await scanImagesWithOcr(message, gc, blocked);
    if (ocrScam) return ocrScam;

    // Fallback bez OCR/po nieudanym OCR. Domyślnie wyłączony, bo może blokować zwykłe obrazki.
    if (
      gc.antiscam?.blockImageOnlyScamScreenshots === true &&
      !text.trim() &&
      !isScamReportChannel(message.channel)
    ) {
      return {
        type: 'image-only',
        value: getAttachmentNames(message) || 'obraz bez tekstu',
        reason: 'Obraz bez opisu został zablokowany w trybie ostrym ochrony przed scam screenami.',
      };
    }
  }

  return null;
}


client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const gc = getGuildConfig(message.guild.id);
  if (!gc.antiscam?.enabled) return;
  if (isSecurityIgnoredMessage(message, gc) && !isScamReportChannel(message.channel)) return;

  const scam = await scanMessageForScam(message, gc);
  if (!scam) return;

  const found = scam.value;
  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  if (gc.antiscam.deleteMessage) {
    await message.delete().catch(() => {});
  }

  if (!gc.antiscam.stats) {
    gc.antiscam.stats = { detected: 0, deleted: 0, muted: 0 };
  }

  gc.antiscam.stats.detected++;
  if (gc.antiscam.deleteMessage) gc.antiscam.stats.deleted++;
  ensureSecurityStats(gc).scamsBlocked++;
  const riskPoints = scam.type === 'ocr+scam-image' ? 35 : scam.type === 'image-only' ? 15 : 30;
  const riskData = addRisk(gc, message.author.id, riskPoints, `AntiScam: ${scam.reason}`, { type: scam.type, value: String(found).slice(0, 120) });

  try {
    await member.timeout(
      (gc.antiscam.muteMinutes || 60) * 60 * 1000,
      `FenixExelent AntiScam: ${found}`
    );
    gc.antiscam.stats.muted++;
  } catch {}

  saveConfig();

  await message.channel.send({
    embeds: [embed(
      '#ff4757',
      '🔍 Scam wykryty!',
      `<@${message.author.id}>, Twoja wiadomość wygląda jak scam i została zablokowana.`,
      [
        { name: 'Wykryto', value: `\`${String(found).slice(0, 180)}\``, inline: true },
        { name: 'Typ', value: scam.type, inline: true },
        { name: 'Powód', value: scam.reason, inline: false },
        { name: 'Mute', value: `${gc.antiscam.muteMinutes || 60} min`, inline: true },
        ...(riskData ? [{ name: 'Risk Score', value: `${riskData.score}/100`, inline: true }] : [])
      ]
    )]
  }).then(msg => {
    setTimeout(() => msg.delete().catch(() => {}), 8000);
  }).catch(() => {});

  await sendLog(message.guild, gc.antiscam.logChannel, embed(
    '#ff4757',
    '🔍 AntiScam — zablokowana wiadomość scam',
    `Wykryto scam od ${message.author.tag}.`,
    [
      { name: 'Użytkownik', value: `<@${message.author.id}>`, inline: true },
      { name: 'Wykryto', value: `\`${String(found).slice(0, 180)}\``, inline: true },
      { name: 'Typ', value: scam.type, inline: true },
      { name: 'Powód', value: scam.reason, inline: false },
      { name: 'Kanał', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Treść', value: message.content.slice(0, 500) || 'Brak treści', inline: false },
      ...(scam.ocrText ? [{ name: 'OCR tekst', value: String(scam.ocrText).slice(0, 900), inline: false }] : []),
      ...(scam.ocrConfidence !== undefined ? [{ name: 'OCR confidence', value: `${scam.ocrConfidence}%`, inline: true }] : [])
    ]
  ));

  await sendModLog(
    message.guild,
    'MUTE (AntiScam)',
    message.author,
    client.user,
    `Scam: ${found} — ${scam.reason}`,
    '#ff4757'
  );
});
// ─── ANTISPAM ──────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const gc = getGuildConfig(message.guild.id);
  if (!gc.antispam.enabled) return;
  if (isSecurityIgnoredMessage(message, gc)) return;

  const uid = message.author.id;
  const now = Date.now();
  const { maxMessages, interval, muteMinutes, logChannel } = gc.antispam;

  if (!spamMap.has(uid)) spamMap.set(uid, []);
  const timestamps = spamMap.get(uid).filter(t => now - t < interval);
  timestamps.push(now);
  spamMap.set(uid, timestamps);

  if (timestamps.length >= maxMessages && !mutedUsers.has(uid)) {
    mutedUsers.add(uid);
    setTimeout(() => mutedUsers.delete(uid), muteMinutes * 60 * 1000);
    try {
      const member = await message.guild.members.fetch(uid).catch(() => null);
      if (!member) return;

      await member.timeout(muteMinutes * 60 * 1000, 'FenixExelent AntiSpam');
      ensureSecurityStats(gc).spamMuted++;
      addRisk(gc, uid, 10, `AntiSpam: ${timestamps.length}/${maxMessages} wiadomości`, { type: 'antispam' });
      saveConfig();

      // Usuń ostatnie wiadomości spamera
      try {
        const msgs = await message.channel.messages.fetch({ limit: 20 });
        const toDelete = msgs.filter(m => m.author.id === uid && now - m.createdTimestamp < 10000);
        if (toDelete.size > 0) await message.channel.bulkDelete(toDelete).catch(() => {});
      } catch {}

      await sendLog(message.guild, logChannel, embed('#ff4757', '🚫 SPAM WYKRYTY',
        `${message.author.tag} został wyciszony za spam.`,
        [
          { name: 'Użytkownik', value: `<@${uid}>`,             inline: true },
          { name: 'Czas muta',  value: `${muteMinutes} minut`,  inline: true },
          { name: 'Wiadomości', value: `${timestamps.length}/${maxMessages}`, inline: true },
        ]
      ));
      await sendModLog(message.guild, 'MUTE (AntiSpam)', message.author, client.user, `Spam: ${timestamps.length} wiad.`, '#ff4757');

      const warn = await message.channel.send({ embeds: [embed(
        '#ff4757', '🚫 Ochrona AntiSpam',
        `<@${uid}>, zostałeś/aś wyciszony/a na ${muteMinutes} minut za spam!`
      )] });
      setTimeout(() => warn.delete().catch(() => {}), 5000);
    } catch (err) {
      logger.error('AntiSpam error:', err);
    }
  }
});

// ─── WELCOME + ANTIRAID ────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const gc = getGuildConfig(member.guild.id);
  markRecentJoin(member);
  await maybeHandleAntiAlt(member).catch(err => logger.error('AntiAlt error:', err));

  // Nadaj rolę Niezweryfikowany nowym osobom
  if (gc.verification?.enabled && gc.verification?.unverifiedRoleId) {
    await member.roles.add(gc.verification.unverifiedRoleId).catch(() => {});
  }

  // Welcome message
  const welcomeId = gc.setup.welcomeId;
  if (welcomeId) {
    const ch = member.guild.channels.cache.get(welcomeId);
    if (ch) {
      await ch.send({ embeds: [
        new EmbedBuilder()
          .setColor('#ff6b00')
          .setTitle('👋 Witaj na FenixExelent!')
          .setDescription(
            `Cześć ${member}, cieszymy się że dołączyłeś/aś!\n\n` +
            '📜 Przeczytaj regulamin zanim zaczniesz rozmawiać.\n' +
            '✅ Wejdź na kanał weryfikacja i kliknij przycisk aby uzyskać dostęp.'
          )
          .setThumbnail(member.user.displayAvatarURL())
          .setFooter({ text: `Jesteś ${member.guild.memberCount}. osobą na serwerze! 🔥` })
          .setTimestamp()
      ] }).catch(() => {});
    }
  }

  // AntiRaid
  if (!gc.antiraid.enabled) {
    await updateStats(member.guild).catch(() => {});
    return;
  }
  const gid = member.guild.id;
  const now = Date.now();
  const { joinThreshold, joinInterval, action, logChannel } = gc.antiraid;

  if (!joinMap.has(gid)) joinMap.set(gid, []);
  const joins = joinMap.get(gid).filter(t => now - t < joinInterval);
  joins.push(now);
  joinMap.set(gid, joins);

  if (joins.length >= joinThreshold) {
    ensureSecurityStats(gc).raidsDetected++;
    addRisk(gc, member.id, 15, `AntiRaid: masowe dołączenia ${joins.length}/${joinThreshold}`, { type: 'antiraid' });
    saveConfig();

    await sendLog(member.guild, logChannel, embed(
      '#ff0000', '🚨 RAID WYKRYTY!',
      `Wykryto masowe dołączenia: ${joins.length} w ciągu ${joinInterval / 1000}s`,
      [
        { name: 'Akcja',               value: action.toUpperCase(), inline: true },
        { name: 'Ostatni dołączający', value: member.user.tag,      inline: true },
      ]
    ));
    try {
      if      (action === 'kick') await member.kick('FenixExelent AntiRaid');
      else if (action === 'ban')  await member.ban({ reason: 'FenixExelent AntiRaid' });
      else if (action === 'mute') await member.timeout(60 * 60 * 1000, 'FenixExelent AntiRaid');
    } catch {}
    joinMap.set(gid, []);
  }

  // Aktualizuj statystyki po dołączeniu
  await updateStats(member.guild).catch(() => {});
});

// Aktualizuj statystyki po wyjściu
client.on('guildMemberRemove', async (member) => {
  await updateStats(member.guild).catch(() => {});
});

// Usuń rolę Niezweryfikowany, gdy użytkownik dostanie rolę Member / zweryfikowaną
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const gc = getGuildConfig(newMember.guild.id);
  if (!gc.verification?.enabled) return;

  const memberRoleId = gc.verification.roleId;
  const unverifiedRoleId = gc.verification.unverifiedRoleId;
  if (!memberRoleId || !unverifiedRoleId) return;

  const gotMemberRole =
    !oldMember.roles.cache.has(memberRoleId) &&
    newMember.roles.cache.has(memberRoleId);

  if (gotMemberRole && newMember.roles.cache.has(unverifiedRoleId)) {
    await newMember.roles.remove(unverifiedRoleId).catch(() => {});
  }
});

// ─── CHANNEL GUARD ──────────────────────────────────────────────────────────
client.on('channelCreate', async (channel) => {
  if (!channel.guild) return;
  const gc = getGuildConfig(channel.guild.id);
  if (!gc.channelGuard.enabled || !gc.channelGuard.blockNewChannels) return;

  await new Promise(r => setTimeout(r, 500));
  try {
    const logs  = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 1 });
    const entry = logs.entries.first();
    if (!entry) return;
    const executor = entry.executor;
    if (!executor || executor.id === client.user.id) return;

    const member = await channel.guild.members.fetch(executor.id).catch(() => null);
    if (member && gc.channelGuard.whitelistedRoles.some(rid => member.roles.cache.has(rid))) return;
    if (member && member.permissions.has(PermissionFlagsBits.Administrator)) return;

    await channel.delete('FenixExelent Channel Guard');
    await sendLog(channel.guild, gc.channelGuard.logChannel, embed(
      '#ffa502', '🔒 CHANNEL GUARD',
      `Kanał #${channel.name} został automatycznie usunięty.`,
      [
        { name: 'Stworzony przez', value: `${executor.tag} (${executor.id})`, inline: true },
        { name: 'Typ',             value: String(channel.type),               inline: true },
      ]
    ));
    await sendModLog(channel.guild, 'CHANNEL DELETE (Guard)', executor, client.user, `Próba stworzenia #${channel.name}`, '#ffa502');
    try {
      await executor.send({ embeds: [embed(
        '#ffa502', '🔒 Kanał usunięty',
        `Na serwerze **${channel.guild.name}** tworzenie kanałów jest zablokowane.`
      )] });
    } catch {}
  } catch (err) {
    logger.error('ChannelGuard error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  SLASH COMMAND HANDLER
// ═══════════════════════════════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    return interaction.reply({ content: '❌ Tej komendy można używać tylko na serwerze.', flags: MessageFlags.Ephemeral });
  }

  const gc = getGuildConfig(interaction.guild.id);
  const { commandName } = interaction;

  if (!canUseCommand(interaction, gc, commandName)) {
    return interaction.reply({ content: '❌ Nie masz uprawnień do użycia tej komendy.', flags: MessageFlags.Ephemeral });
  }

  try {
    await handleCommand(interaction, gc, commandName);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ Ta komenda nie ma aktywnej obsługi. Uruchom ponownie wdrażanie komend.', flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    logger.commandError(err, interaction, commandName);
    const errMsg = { embeds: [embed('#ff4757', '❌ Błąd', 'Wystąpił nieoczekiwany błąd. Spróbuj ponownie.')], flags: MessageFlags.Ephemeral };
    if (interaction.deferred)       await interaction.editReply(errMsg).catch(() => {});
    else if (!interaction.replied)  await interaction.reply(errMsg).catch(() => {});
  
  }

});

async function handleCommand(interaction, gc, commandName) {

// ── help ─────────────────────────────────────────────
if (commandName === 'help') {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor('#ff6b00')
        .setTitle('🔥 FenixExelent — Panel Pomocy')
        .setDescription('Kompletna lista komend dostępnych na serwerze')
        .addFields(
          { name: '⚙️ Konfiguracja',   value: '`setup` `security` `servercheck` `dashboard` `stats` `refreshbot` `backup` `appeal`',                                 inline: false },
          { name: '🚫 AntiSpam',        value: '`antispam on` `antispam off` `antispam set` `antispam log`',                                    inline: true  },
          { name: '🚨 AntiRaid',        value: '`antiraid on` `antiraid off` `antiraid set` `antiraid lockdown` `antiraid log`',                inline: true  },
          { name: '🔒 Channel Guard',   value: '`channelguard on` `channelguard off` `channelguard whitelist` `channelguard log`',              inline: true  },
          { name: '✅ Weryfikacja',     value: '`verification setup` `verification on` `verification off` `verification panel`',               inline: true  },
          { name: '🎫 Tickety',         value: '`ticket setup` `ticket on` `ticket off` `ticket panel`',                                       inline: true  },
          { name: '🔧 Moderacja',       value: '`warn` `warnings` `clearwarns` `kick` `ban` `unban` `unmute`',                                 inline: true  },
          { name: '📋 Mod Log',         value: '`modlog` `securityignore` `privacy` `terms` `about` `support`',                                                       inline: true  },
        )
        .setFooter({ text: 'FenixExelent 🔥 | Wszystkie komendy' })
        .setTimestamp()
      ],
      flags: MessageFlags.Ephemeral,
    });
  }


  // ── dashboard ─────────────────────────────────────────────────────────


  if (commandName === 'dashboard') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Otwórz Dashboard')
        .setStyle(ButtonStyle.Link)
        .setURL(config.dashboardUrl)
        .setEmoji('🌐')
    );
    return interaction.reply({
      embeds: [embed(
        '#ff6b00', '🌐 Dashboard FenixExelent',
        `Panel webowy dostępny pod adresem:\n${config.dashboardUrl}\n\nZaloguj się przez Discord aby zarządzać ustawieniami serwera.`
      )],
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── setup ─────────────────────────────────────────────────────────────
  if (commandName === 'setup') {
    await interaction.deferReply();
    const guild = interaction.guild;
    await guild.members.fetch().catch(() => {});

    const membersCount = guild.members.cache.filter(m => !m.user.bot).size;
    const botsCount    = guild.members.cache.filter(m =>  m.user.bot).size;
    const totalCount   = guild.memberCount;

    const roVO   = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect],      allow: [PermissionFlagsBits.ViewChannel] }];
    const roText = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel] }];
    const rwText = [{ id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }];

    // Statystyki
    const catStats  = await getOrCreateCategory(guild, '📊 STATYSTYKI');
    const chMembers = await getOrCreateVoice(guild, catStats, `👥 Członkowie: ${membersCount}`, roVO);
    const chBots    = await getOrCreateVoice(guild, catStats, `🤖 Boty: ${botsCount}`,          roVO);
    const chTotal   = await getOrCreateVoice(guild, catStats, `🌐 Razem: ${totalCount}`,         roVO);

    gc.setup.statsMembersId = chMembers.id;
    gc.setup.statsBotsId    = chBots.id;
    gc.setup.statsTotalId   = chTotal.id;

    // Informacje
    const catInfo = await getOrCreateCategory(guild, '📋 INFORMACJE');
    const chReg   = await getOrCreateText(guild, catInfo, '📜│regulamin', roText);
    await chReg.bulkDelete(10).catch(() => {});
    await chReg.send({ embeds: [new EmbedBuilder()
      .setColor('#ff6b00')
      .setTitle('📜 Regulamin FenixExelent')
      .addFields(
        { name: '§1 – Zachowanie', value: '• Szanuj innych.\n• Zakaz obrażania i dyskryminacji.\n• Zakaz nadmiernego wulgaryzowania.',  inline: false },
        { name: '§2 – Treści',     value: '• Zakaz spamu i floodowania.\n• Zakaz reklam bez zgody admina.\n• Zakaz treści NSFW.',         inline: false },
        { name: '§3 – Prywatność', value: '• Zakaz udostępniania danych osobowych innych.\n• Zakaz nagrywania bez zgody.',                inline: false },
        { name: '§4 – Kary',       value: '• Naruszenie = warn → mute → kick → ban.\n• Decyzje administracji są ostateczne.',             inline: false },
      )
      .setFooter({ text: 'Dołączając akceptujesz regulamin. 🔥' })
    ] });

    // Weryfikacja — /setup ma przygotować kompletny, aktywny system.
    const catVerify = await getOrCreateCategory(guild, '🔐 WERYFIKACJA');
    const chVerify  = await getOrCreateText(guild, catVerify, '✅│weryfikacja', rwText);
    gc.verification.channelId = chVerify.id;

    const verificationSetup = await ensureVerificationForAntiAlt(guild, gc);
    if (!verificationSetup.ok) {
      throw new Error('Nie udało się utworzyć ról lub kanału weryfikacji. Sprawdź uprawnienia bota.');
    }

    await chVerify.bulkDelete(10).catch(() => {});
    await sendVerifyPanel(chVerify);

    // Tickety
    const catTickets = await getOrCreateCategory(guild, '🎫 TICKETY');
    gc.tickets.categoryId = catTickets.id;

    // Powitania
    const catGeneral = await getOrCreateCategory(guild, '👋 OGÓLNE');
    const chWelcome  = await getOrCreateText(guild, catGeneral, '🎉│powitania', roText);
    gc.setup.welcomeId = chWelcome.id;

    // Logi mod
    const chModLog = await getOrCreateText(guild, catInfo, '📋│logi-mod', [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
    ]);
    gc.modLog.channelId = chModLog.id;

    saveConfig();

    return interaction.editReply({ embeds: [embed(
      '#ff6b00', '✅ Konfiguracja zakończona!',
      'Wszystkie kanały zostały pomyślnie utworzone.',
      [
        { name: '📊 Statystyki',   value: `<#${chMembers.id}> <#${chBots.id}> <#${chTotal.id}>`, inline: false },
        { name: '📜 Regulamin',    value: `<#${chReg.id}>`,      inline: true },
        { name: '✅ Weryfikacja',  value: `<#${chVerify.id}>`,   inline: true },
        { name: '🎉 Powitania',    value: `<#${chWelcome.id}>`,  inline: true },
        { name: '📋 Logi Mod',     value: `<#${chModLog.id}>`,   inline: true },
        { name: '🎫 Kat. Tickety', value: `<#${catTickets.id}>`, inline: true },
      ]
    )] });
  }

  // ── security ──────────────────────────────────────────────────────────
  if (commandName === 'security') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Dashboard').setStyle(ButtonStyle.Link)
        .setURL(config.dashboardUrl).setEmoji('🌐'),
      new ButtonBuilder().setCustomId('status_btn').setLabel('Status').setStyle(ButtonStyle.Primary).setEmoji('📊'),
      new ButtonBuilder().setCustomId('lockdown_toggle').setLabel('Lockdown').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    );
    return interaction.reply({
      embeds: [embed(
        '#ff6b00', '🛡️ Panel Bezpieczeństwa FenixExelent',
        'Zarządzaj modułami ochrony serwera.',
        [
          { name: '🚫 AntiSpam',    value: gc.antispam.enabled               ? '✅ Aktywny'  : '❌ Wyłączony', inline: true },
          { name: '🚨 AntiRaid',    value: gc.antiraid.enabled               ? '✅ Aktywny'  : '❌ Wyłączony', inline: true },
          { name: '🔒 ChanGuard',   value: gc.channelGuard.blockNewChannels  ? '✅ Blokada'  : '❌ Wyłączony', inline: true },
          { name: '✅ Weryfikacja', value: gc.verification.enabled           ? '✅ Aktywna'  : '❌ Wyłączona', inline: true },
          { name: '🎫 Tickety',     value: gc.tickets.enabled                ? '✅ Aktywne'  : '❌ Wyłączone', inline: true },
          { name: '🔒 Lockdown',    value: gc.antiraid.lockdownActive         ? '🔴 AKTYWNY' : '🟢 Wyłączony', inline: true },
        ]
      )],
      components: [row],
    });
  }

  // ── status ────────────────────────────────────────────────────────────
  if (commandName === 'status') {
    return interaction.reply({
      embeds: [embed(
        '#ff6b00', `📊 Status FenixExelent — ${interaction.guild.name}`,
        'Szczegółowy status wszystkich modułów',
        [
          { name: '🚫 AntiSpam',
            value: `${gc.antispam.enabled ? '✅' : '❌'} ${gc.antispam.enabled ? 'Aktywny' : 'Wyłączony'}\nLimit: ${gc.antispam.maxMessages} msg / ${gc.antispam.interval / 1000}s\nMute: ${gc.antispam.muteMinutes} min`,
            inline: true },
          { name: '🚨 AntiRaid',
            value: `${gc.antiraid.enabled ? '✅' : '❌'} ${gc.antiraid.enabled ? 'Aktywny' : 'Wyłączony'}\nPróg: ${gc.antiraid.joinThreshold} / ${gc.antiraid.joinInterval / 1000}s\nAkcja: ${gc.antiraid.action.toUpperCase()}\nLockdown: ${gc.antiraid.lockdownActive ? '🔒 TAK' : '🔓 NIE'}`,
            inline: true },
          { name: '🔒 Channel Guard',
            value: `${gc.channelGuard.blockNewChannels ? '✅ Blokada' : '❌ Wyłączony'}\nWhitelist: ${gc.channelGuard.whitelistedRoles.length} ról`,
            inline: true },
          { name: '✅ Weryfikacja',
            value: `${gc.verification.enabled ? '✅ Aktywna' : '❌ Wyłączona'}${gc.verification.roleId ? `\nRola: <@&${gc.verification.roleId}>` : ''}`,
            inline: true },
          { name: '🎫 Tickety',
            value: `${gc.tickets.enabled ? '✅ Aktywne' : '❌ Wyłączone'}${gc.tickets.supportRoleId ? `\nSupport: <@&${gc.tickets.supportRoleId}>` : ''}`,
            inline: true },
          { name: '📡 Bot',
            value: `Ping: ${client.ws.ping}ms\nUptime: ${Math.floor(process.uptime() / 60)} min\nSerwery: ${client.guilds.cache.size}`,
            inline: true },
        ]
      )],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── stats ─────────────────────────────────────────────────────────────
  if (commandName === 'stats') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await updateStats(interaction.guild);
    return interaction.editReply({ embeds: [embed('#2ed573', '✅ Statystyki odświeżone', 'Kanały statystyk zostały zaktualizowane.')] });
  }

  // ── reaction roles ──────────────────────────────────────────────────
  if (commandName === 'reactionroles') {
    const sub = interaction.options.getSubcommand();
    const reactionRoles = ensureReactionRolesConfig(gc);
    if (sub === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channel = interaction.options.getChannel('kanal') || interaction.channel;
      const result = await createReactionRolesPanelForChannel(channel);
      return interaction.editReply({ content: `✅ Panel ról został utworzony w <#${result.channelId}>.` });
    }
    if (sub === 'status') {
      const link = reactionRoles.channelId && reactionRoles.messageId
        ? `https://discord.com/channels/${interaction.guild.id}/${reactionRoles.channelId}/${reactionRoles.messageId}`
        : 'Brak panelu';
      return interaction.reply({ content: `Reaction Roles: **${reactionRoles.enabled ? 'włączone' : 'wyłączone'}**\nPanel: ${link}`, flags: MessageFlags.Ephemeral });
    }
    reactionRoles.enabled = false;
    saveConfig();
    return interaction.reply({ content: '✅ Reaction Roles zostały wyłączone.', flags: MessageFlags.Ephemeral });
  }

  // ── antialt ─────────────────────────────────────────────────────────
  if (commandName === 'antialt') {
    const sub = interaction.options.getSubcommand();
    if (!gc.antialt) gc.antialt = { enabled: false, minAccountAgeDays: 7, action: 'verify', logChannel: null, riskPoints: 20 };

    if (sub === 'on') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const setup = await ensureVerificationForAntiAlt(interaction.guild, gc);
      gc.antialt.enabled = true;
      saveConfig();

      return interaction.editReply({ embeds: [embed(
        setup.ok ? '#2ed573' : '#ffa502',
        setup.ok ? '✅ AntiAlt włączony' : '⚠️ AntiAlt włączony, ale sprawdź uprawnienia',
        `Nowe konta młodsze niż **${gc.antialt.minAccountAgeDays || 7} dni** będą oznaczane do dodatkowej weryfikacji.\n\n` +
        (setup.ok
          ? `Weryfikacja gotowa: ${setup.verifyChannel ? `<#${setup.verifyChannel.id}>` : 'kanał weryfikacji'}`
          : 'Nie udało się w pełni utworzyć roli/kanału weryfikacji. Sprawdź uprawnienia bota.'),
        [
          { name: 'Rola po weryfikacji', value: setup.verifiedRole ? `<@&${setup.verifiedRole.id}>` : 'Brak', inline: true },
          { name: 'Rola przed weryfikacją', value: setup.unverifiedRole ? `<@&${setup.unverifiedRole.id}>` : 'Brak', inline: true },
          { name: 'Kanał', value: setup.verifyChannel ? `<#${setup.verifyChannel.id}>` : 'Brak', inline: true },
        ]
      )] });
    }

    if (sub === 'off') {
      gc.antialt.enabled = false;
      saveConfig();
      return interaction.reply({ embeds: [embed('#ff4757', '❌ AntiAlt wyłączony', 'Ochrona przed świeżymi kontami została wyłączona.')], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'set') {
      const days = interaction.options.getInteger('mindays');
      const log = interaction.options.getChannel('logi');
      if (days !== null) gc.antialt.minAccountAgeDays = days;
      if (log) gc.antialt.logChannel = log.id;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiAlt zaktualizowany', `Minimum wieku konta: **${gc.antialt.minAccountAgeDays} dni**${gc.antialt.logChannel ? `\nLogi: <#${gc.antialt.logChannel}>` : ''}`)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'status') {
      return interaction.reply({ embeds: [embed('#ff6b00', '🆕 Status AntiAlt', 'Ochrona przed świeżymi kontami.', [
        { name: 'Status', value: gc.antialt.enabled ? '✅ Włączony' : '❌ Wyłączony', inline: true },
        { name: 'Min wiek konta', value: `${gc.antialt.minAccountAgeDays || 7} dni`, inline: true },
        { name: 'Risk +', value: `${gc.antialt.riskPoints || 20}`, inline: true },
        { name: 'Logi', value: gc.antialt.logChannel ? `<#${gc.antialt.logChannel}>` : 'Auto', inline: true },
      ])], flags: MessageFlags.Ephemeral });
    }
  }

  // ── risk ─────────────────────────────────────────────────────────────
  if (commandName === 'risk') {
    const user = interaction.options.getUser('uzytkownik') || interaction.user;
    const data = getUserRiskData(gc, user.id);
    const level = getRiskLevel(data.score);
    const events = data.events.length
      ? data.events.slice(0, 8).map((e, i) => `**${i + 1}.** ${e.points > 0 ? '+' : ''}${e.points} — ${e.reason} (${new Date(e.date).toLocaleString('pl-PL')})`).join('\n')
      : 'Brak zdarzeń risk.';

    return interaction.reply({ embeds: [embed(
      level.color,
      `📊 Risk Score — ${user.tag}`,
      `Poziom: **${level.label}**\nScore: **${data.score}/100**`,
      [
        { name: 'Użytkownik', value: `<@${user.id}>`, inline: true },
        { name: 'Aktualizacja', value: data.updatedAt ? new Date(data.updatedAt).toLocaleString('pl-PL') : 'Brak', inline: true },
        { name: 'Ostatnie zdarzenia', value: events.slice(0, 1000), inline: false },
      ]
    )], flags: MessageFlags.Ephemeral });
  }

  // ── reportscam ───────────────────────────────────────────────────────
  if (commandName === 'reportscam') {
    const link = interaction.options.getString('link');
    const user = interaction.options.getUser('uzytkownik');
    const opis = interaction.options.getString('opis') || 'Brak opisu';

    if (!link && !user) {
      return interaction.reply({ content: '❌ Podaj link/domenę albo użytkownika do zgłoszenia.', flags: MessageFlags.Ephemeral });
    }

    const reportId = makeReportId();
    const domain = getFirstDomainFromText(link || '') || normalizeDomainInput(link || '');
    const logChannelId = getBestLogChannelId(gc);
    const logChannel = logChannelId ? await interaction.guild.channels.fetch(logChannelId).catch(() => null) : interaction.channel;

    const reportData = {
      reportId,
      guildId: interaction.guild.id,
      reporterId: interaction.user.id,
      targetId: user?.id || null,
      link: link || null,
      domain: domain && domain.includes('.') ? domain : null,
      opis,
      channelId: interaction.channel.id,
      createdAt: Date.now(),
    };
    scamReports.set(reportId, reportData);
    if (!gc.scamReports) gc.scamReports = {};
    gc.scamReports[reportId] = reportData;

    ensureSecurityStats(gc).reportsCreated++;
    saveConfig();

    const msg = await logChannel.send({
      embeds: [embed(
        '#ff6b00',
        '🚨 Nowe zgłoszenie scam',
        'Staff może od razu dodać domenę do blacklisty, wyciszyć lub zbanować użytkownika.',
        [
          { name: 'Zgłaszający', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Podejrzany użytkownik', value: user ? `<@${user.id}>` : 'Nie podano', inline: true },
          { name: 'Domena/link', value: link ? `\`${String(link).slice(0, 500)}\`` : 'Nie podano', inline: false },
          { name: 'Wykryta domena', value: domain ? `\`${domain}\`` : 'Brak', inline: true },
          { name: 'Opis', value: opis.slice(0, 700), inline: false },
          { name: 'ID zgłoszenia', value: `\`${reportId}\``, inline: true },
        ]
      )],
      components: buildScamReportButtons(reportId),
    }).catch(() => null);

    return interaction.reply({ content: msg ? `✅ Zgłoszenie scam wysłane do ${logChannel}.` : '✅ Zgłoszenie zapisane, ale nie udało się wysłać na kanał logów.', flags: MessageFlags.Ephemeral });
  }

  // ── securitystats ────────────────────────────────────────────────────
  if (commandName === 'securitystats') {
    const stats = ensureSecurityStats(gc);
    return interaction.reply({ embeds: [embed('#ff6b00', '🛡️ Statystyki bezpieczeństwa', 'Statystyki tego serwera.', [
      { name: 'Scamy zablokowane', value: `${stats.scamsBlocked || 0}`, inline: true },
      { name: 'Spam muty', value: `${stats.spamMuted || 0}`, inline: true },
      { name: 'Raidy wykryte', value: `${stats.raidsDetected || 0}`, inline: true },
      { name: 'Nowe konta AntiAlt', value: `${stats.altDetections || 0}`, inline: true },
      { name: 'Zgłoszenia scam', value: `${stats.reportsCreated || 0}`, inline: true },
      { name: 'Emergency aktywacje', value: `${stats.emergencyActivations || 0}`, inline: true },
    ])], flags: MessageFlags.Ephemeral });
  }


  // ── public launch pack ───────────────────────────────────────────────
  if (['privacy', 'terms', 'about', 'support'].includes(commandName)) {
    const url = `${config.dashboardUrl}/${commandName}`;
    const labels = { privacy: 'Privacy Policy', terms: 'Terms of Service', about: 'About', support: 'Support' };
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(labels[commandName]).setStyle(ButtonStyle.Link).setURL(url).setEmoji('🌐')
    );
    return interaction.reply({ embeds: [embed('#ff6b00', `🌐 ${labels[commandName]}`, `Otwórz stronę: ${url}`)], components: [row], flags: MessageFlags.Ephemeral });
  }

  // ── servercheck ──────────────────────────────────────────────────────
  if (commandName === 'servercheck') {
    const result = calculateServerSecurityScore(gc);
    const color = result.score >= 85 ? '#2ed573' : result.score >= 60 ? '#f59e0b' : '#ff4757';
    const lines = result.checks.map(c => `${c.ok ? '✅' : '❌'} ${c.label} ${c.ok ? `(+${c.points})` : ''}`).join('\n');
    return interaction.reply({ embeds: [embed(
      color,
      `🧪 Server Security Score — ${result.score}/100`,
      result.score >= 85 ? 'Serwer wygląda bardzo dobrze zabezpieczony.' : 'Poniżej masz rzeczy do poprawienia.',
      [{ name: 'Checklist', value: lines.slice(0, 1000), inline: false }]
    )], flags: MessageFlags.Ephemeral });
  }

  // ── securityignore ───────────────────────────────────────────────────
  if (commandName === 'securityignore') {
    const sub = interaction.options.getSubcommand();
    const ignore = ensureSecurityIgnore(gc);

    if (sub === 'channel') {
      const channel = interaction.options.getChannel('kanal');
      if (!ignore.channels.includes(channel.id)) ignore.channels.push(channel.id);
      saveConfig();
      return interaction.reply({ content: `✅ Kanał <#${channel.id}> będzie ignorowany przez automatyczne zabezpieczenia.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'role') {
      const role = interaction.options.getRole('rola');
      if (!ignore.roles.includes(role.id)) ignore.roles.push(role.id);
      saveConfig();
      return interaction.reply({ content: `✅ Rola <@&${role.id}> będzie ignorowana przez automatyczne zabezpieczenia.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'removechannel') {
      const channel = interaction.options.getChannel('kanal');
      ignore.channels = ignore.channels.filter(id => id !== channel.id);
      saveConfig();
      return interaction.reply({ content: `🗑️ Usunięto kanał <#${channel.id}> z ignorowanych.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'removerole') {
      const role = interaction.options.getRole('rola');
      ignore.roles = ignore.roles.filter(id => id !== role.id);
      saveConfig();
      return interaction.reply({ content: `🗑️ Usunięto rolę <@&${role.id}> z ignorowanych.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'list') {
      const channels = ignore.channels.length ? ignore.channels.map(id => `<#${id}>`).join('\n') : 'Brak';
      const roles = ignore.roles.length ? ignore.roles.map(id => `<@&${id}>`).join('\n') : 'Brak';
      return interaction.reply({ embeds: [embed('#ff6b00', '🧾 Ignorowane kanały/role', 'Te miejsca nie są karane przez automatyczne filtry.', [
        { name: 'Kanały', value: channels.slice(0, 1000), inline: true },
        { name: 'Role', value: roles.slice(0, 1000), inline: true },
      ])], flags: MessageFlags.Ephemeral });
    }
  }

  // ── backup ───────────────────────────────────────────────────────────
  if (commandName === 'backup') {
    const sub = interaction.options.getSubcommand();
    if (!gc.backups) gc.backups = {};

    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const backup = createServerBackup(interaction.guild, gc);
      return interaction.editReply({ embeds: [embed('#2ed573', '✅ Backup utworzony', `ID backupu: \`${backup.id}\``, [
        { name: 'Role', value: `${backup.roles.length}`, inline: true },
        { name: 'Kanały', value: `${backup.channels.length}`, inline: true },
      ])] });
    }
    if (sub === 'list') {
      const list = Object.values(gc.backups).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const value = list.length ? list.slice(0, 10).map(b => `• \`${b.id}\` — ${new Date(b.createdAt).toLocaleString('pl-PL')} — ${b.channels?.length || 0} kanałów`).join('\n') : 'Brak backupów.';
      return interaction.reply({ embeds: [embed('#ff6b00', '📦 Backupy serwera', value)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'restore') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const id = interaction.options.getString('id');
      const result = await restoreServerBackup(interaction.guild, gc, id);
      if (!result) return interaction.editReply({ content: '❌ Nie znaleziono backupu o tym ID.' });
      saveConfig();
      return interaction.editReply({ embeds: [embed('#2ed573', '♻️ Backup przywrócony', `Przywrócono brakujące role i kanały z \`${id}\`.`, [
        { name: 'Role utworzone', value: `${result.rolesCreated}`, inline: true },
        { name: 'Kanały utworzone', value: `${result.channelsCreated}`, inline: true },
        { name: 'Błędy', value: `${result.failed}`, inline: true },
      ])] });
    }
  }

  // ── appeal ───────────────────────────────────────────────────────────
  if (commandName === 'appeal') {
    const sub = interaction.options.getSubcommand();
    const appeals = ensureAppeals(gc);

    if (sub === 'setup') {
      const channel = interaction.options.getChannel('kanal');
      appeals.enabled = true;
      appeals.channelId = channel.id;
      saveConfig();
      return interaction.reply({ content: `✅ Kanał appeali ustawiony: <#${channel.id}>`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'submit') {
      if (!appeals.enabled) return interaction.reply({ content: '❌ System appeal jest wyłączony.', flags: MessageFlags.Ephemeral });
      const reason = interaction.options.getString('powod');
      const appealId = makeAppealId();
      appeals.cases[appealId] = {
        id: appealId,
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        reason,
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      ensureSecurityStats(gc).appealsCreated++;
      saveConfig();
      const ch = appeals.channelId ? await interaction.guild.channels.fetch(appeals.channelId).catch(() => null) : await interaction.guild.channels.fetch(getBestLogChannelId(gc)).catch(() => null);
      if (ch) {
        await ch.send({ embeds: [embed('#ff6b00', '📝 Nowe odwołanie / Appeal', `Użytkownik <@${interaction.user.id}> wysłał odwołanie.`, [
          { name: 'ID', value: `\`${appealId}\``, inline: true },
          { name: 'Użytkownik', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Powód', value: reason.slice(0, 1000), inline: false },
        ])], components: buildAppealButtons(appealId) }).catch(() => {});
      }
      return interaction.reply({ content: `✅ Odwołanie wysłane. ID: \`${appealId}\``, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'review') {
      const id = interaction.options.getString('id');
      const a = appeals.cases[id];
      if (!a) return interaction.reply({ content: '❌ Nie znaleziono appeala.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [embed('#ff6b00', `📝 Appeal ${id}`, `Status: **${a.status}**`, [
        { name: 'Użytkownik', value: `<@${a.userId}>`, inline: true },
        { name: 'Data', value: new Date(a.createdAt).toLocaleString('pl-PL'), inline: true },
        { name: 'Powód', value: a.reason.slice(0, 1000), inline: false },
      ])], flags: MessageFlags.Ephemeral });
    }
  }

  // ── emergency ────────────────────────────────────────────────────────
  if (commandName === 'emergency') {
    const sub = interaction.options.getSubcommand();
    if (!gc.emergency) gc.emergency = { active: false, previous: null };

    if (sub === 'on') {
      await interaction.deferReply();
      const result = await enableEmergencyMode(interaction.guild, gc);
      await sendLog(interaction.guild, getBestLogChannelId(gc), embed('#ff4757', '🚨 Emergency Mode ON', `${interaction.user.tag} włączył tryb awaryjny.`, [
        { name: 'Lockdown', value: `${result.lockdown.changed} zmian / ${result.lockdown.failed} błędów`, inline: true },
        { name: 'Zaproszenia', value: result.invites?.skipped ? '✅ Zachowane' : `${result.invites.deleted} usunięte`, inline: true },
      ]));
      return interaction.editReply({ embeds: [embed('#ff4757', '🚨 Emergency Mode włączony', 'Serwer został zabezpieczony: lockdown oraz mocniejszy AntiSpam/AntiRaid/AntiScam. Zaproszenia nie są usuwane.', [
        { name: 'Lockdown', value: `${result.lockdown.changed} kanałów`, inline: true },
        { name: 'Zaproszenia', value: result.invites?.skipped ? '✅ Zachowane' : `${result.invites.deleted} usunięte`, inline: true },
        { name: 'OCR/AntiScam', value: '✅ Tryb ostry', inline: true },
      ])] });
    }

    if (sub === 'off') {
      await interaction.deferReply();
      const result = await disableEmergencyMode(interaction.guild, gc);
      await sendLog(interaction.guild, getBestLogChannelId(gc), embed('#2ed573', '✅ Emergency Mode OFF', `${interaction.user.tag} wyłączył tryb awaryjny.`));
      return interaction.editReply({ embeds: [embed('#2ed573', '✅ Emergency Mode wyłączony', 'Kanały zostały odblokowane, a ustawienia ochrony przywrócone z kopii.', [
        { name: 'Odblokowane', value: `${result.lockdown.changed} kanałów`, inline: true },
        { name: 'Błędy', value: `${result.lockdown.failed}`, inline: true },
      ])] });
    }

    if (sub === 'status') {
      return interaction.reply({ embeds: [embed(
        gc.emergency.active ? '#ff4757' : '#2ed573',
        '🚨 Status Emergency Mode',
        gc.emergency.active ? 'Tryb awaryjny jest aktywny.' : 'Tryb awaryjny jest wyłączony.',
        [
          { name: 'AntiSpam', value: gc.antispam.enabled ? '✅' : '❌', inline: true },
          { name: 'AntiRaid', value: gc.antiraid.enabled ? '✅' : '❌', inline: true },
          { name: 'AntiScam', value: gc.antiscam.enabled ? '✅' : '❌', inline: true },
          { name: 'Lockdown', value: gc.antiraid.lockdownActive ? '🔒 Tak' : '🔓 Nie', inline: true },
        ]
      )], flags: MessageFlags.Ephemeral });
    }
  }

  // ── refreshbot ────────────────────────────────────────────────────────
  if (commandName === 'refreshbot') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let refreshed = 0;
    let failed = 0;

    try {
      await initializeConfig();
      updateBotPresence();

      for (const [, guild] of client.guilds.cache) {
        try {
          await updateStats(guild);
          refreshed++;
        } catch (err) {
          failed++;
          logger.error(`RefreshBot stats error (${guild.id}):`, err.message);
        }
      }

      return interaction.editReply({
        embeds: [embed(
          '#2ed573',
          '🔄 Bot odświeżony',
          'Odświeżono konfigurację, status bota oraz statystyki na serwerach.',
          [
            { name: 'Serwery odświeżone', value: `${refreshed}`, inline: true },
            { name: 'Błędy', value: `${failed}`, inline: true },
            { name: 'Serwery bota', value: `${client.guilds.cache.size}`, inline: true },
          ]
        )],
      });
    } catch (err) {
      logger.error('RefreshBot error:', err);

      return interaction.editReply({
        embeds: [embed(
          '#ff4757',
          '❌ Błąd odświeżania',
          'Nie udało się odświeżyć bota. Sprawdź logi konsoli.'
        )],
      });
    }
  }


  // ── ocrscan ───────────────────────────────────────────────────────────
  if (commandName === 'ocrscan') {
    const sub = interaction.options.getSubcommand();
    if (!gc.antiscam) gc.antiscam = defaultGuildConfig().antiscam;

    if (sub === 'on') {
      gc.antiscam.blockScamImages = true;
      gc.antiscam.ocrScamImages = true;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ OCR AntiScam włączony', 'Bot będzie czytał tekst ze screenów i blokował obrazy scam/crypto/casino.')], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'off') {
      gc.antiscam.ocrScamImages = false;
      saveConfig();
      return interaction.reply({ embeds: [embed('#ff4757', '❌ OCR AntiScam wyłączony', 'Bot nadal blokuje domeny/linki, ale nie czyta tekstu ze screenów.')], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'strict') {
      const aktywny = interaction.options.getBoolean('aktywny');
      gc.antiscam.blockImageOnlyScamScreenshots = aktywny;
      saveConfig();
      return interaction.reply({ embeds: [embed(
        aktywny ? '#ff4757' : '#2ed573',
        aktywny ? '⚠️ Tryb ostry włączony' : '✅ Tryb ostry wyłączony',
        aktywny
          ? 'Bot będzie blokował też same obrazki bez tekstu poza kanałami zgłoszeń scam.'
          : 'Bot będzie karał obrazki głównie wtedy, gdy OCR lub opis wykryje scam.'
      )], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'status') {
      return interaction.reply({ embeds: [embed(
        '#ff6b00',
        '👁️ Status OCR AntiScam',
        'Aktualne ustawienia skanowania screenów.',
        [
          { name: 'OCR screenów', value: gc.antiscam.ocrScamImages ? '✅ Włączony' : '❌ Wyłączony', inline: true },
          { name: 'Tryb ostry', value: gc.antiscam.blockImageOnlyScamScreenshots ? '✅ Włączony' : '❌ Wyłączony', inline: true },
          { name: 'Min score', value: `${gc.antiscam.ocrMinScamScore || 3}`, inline: true },
          { name: 'Max obrazów', value: `${gc.antiscam.ocrMaxImages || 2}`, inline: true },
          { name: 'Timeout', value: `${gc.antiscam.ocrTimeoutMs || 25000} ms`, inline: true },
          { name: 'Tesseract', value: Tesseract ? '✅ Załadowany' : '❌ Brak paczki', inline: true },
        ]
      )], flags: MessageFlags.Ephemeral });
    }
  }

  // ── modlog ────────────────────────────────────────────────────────────
  if (commandName === 'modlog') {
    const ch = interaction.options.getChannel('kanal');
    gc.modLog.channelId = ch.id;
    saveConfig();
    return interaction.reply({ embeds: [embed('#2ed573', '✅ Mod Log ustawiony', `Logi moderacji → <#${ch.id}>`)], flags: MessageFlags.Ephemeral });
  }

  // ── antispam ──────────────────────────────────────────────────────────
  if (commandName === 'antispam') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on')  { gc.antispam.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiSpam włączony',  'Ochrona aktywna.')],    flags: MessageFlags.Ephemeral }); }
    if (sub === 'off') { gc.antispam.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ AntiSpam wyłączony', 'Ochrona wyłączona.')], flags: MessageFlags.Ephemeral }); }
    if (sub === 'set') {
      gc.antispam.maxMessages = interaction.options.getInteger('wiadomosci');
      gc.antispam.interval    = interaction.options.getInteger('czas') * 1000;
      const mute = interaction.options.getInteger('mute');
      if (mute) gc.antispam.muteMinutes = mute;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiSpam zaktualizowany', `Limit: ${gc.antispam.maxMessages} msg / ${gc.antispam.interval / 1000}s, mute: ${gc.antispam.muteMinutes} min`)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'log') {
      gc.antispam.logChannel = interaction.options.getChannel('kanal').id;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Logi ustawione', `AntiSpam → <#${gc.antispam.logChannel}>`)], flags: MessageFlags.Ephemeral });
    }
  }
  // ── antiscam ──────────────────────────────────────────────────────────
  if (commandName === 'antiscam') {
    const sub = interaction.options.getSubcommand();

    if (!gc.antiscam) {
      gc.antiscam = {
        enabled: true,
        muteMinutes: 60,
        deleteMessage: true,
        logChannel: null,
        blockScamImages: true,
        ocrScamImages: true,
        ocrMinScamScore: 3,
        ocrMaxImages: 2,
        ocrTimeoutMs: 25000,
        ocrMaxImageBytes: 8 * 1024 * 1024,
        allowScamReportsInReportChannels: true,
        blockImageOnlyScamScreenshots: false,
        whitelistedDomains: [],
        blockedDomains: [...DEFAULT_BLOCKED_DOMAINS],
        stats: { detected: 0, deleted: 0, muted: 0 },
        riskScores: {},
      };
    }

    if (sub === 'on') {
      gc.antiscam.enabled = true;
      saveConfig();
      return interaction.reply({
        embeds: [embed('#2ed573', '✅ AntiScam włączony', 'Ochrona przed scam linkami jest aktywna.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'off') {
      gc.antiscam.enabled = false;
      saveConfig();
      return interaction.reply({
        embeds: [embed('#ff4757', '❌ AntiScam wyłączony', 'Ochrona przed scam linkami została wyłączona.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'set') {
      const mute = interaction.options.getInteger('mute');
      const del = interaction.options.getBoolean('delete');

      if (mute !== null) gc.antiscam.muteMinutes = mute;
      if (del !== null) gc.antiscam.deleteMessage = del;

      saveConfig();

      return interaction.reply({
        embeds: [embed(
          '#2ed573',
          '✅ AntiScam zaktualizowany',
          `Mute: **${gc.antiscam.muteMinutes || 60} min**\nUsuwanie wiadomości: **${gc.antiscam.deleteMessage ? 'Tak' : 'Nie'}**`
        )],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'whitelist') {
      const input = interaction.options.getString('domena');
      const domains = normalizeBlockedDomains([input]);

      if (!gc.antiscam.whitelistedDomains) gc.antiscam.whitelistedDomains = [];

      let added = 0;
      for (const domain of domains) {
        if (!gc.antiscam.whitelistedDomains.includes(domain)) {
          gc.antiscam.whitelistedDomains.push(domain);
          added++;
        }
      }

      gc.antiscam.whitelistedDomains = normalizeBlockedDomains(gc.antiscam.whitelistedDomains);
      saveConfig();

      return interaction.reply({
        embeds: [embed(
          '#2ed573',
          '✅ Domena dodana do whitelisty AntiScam',
          added
            ? domains.map(d => `• \`${d}\``).join('\n')
            : 'Nie dodano nowej domeny. Ta domena mogła już być na whitelist.'
        )],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'log') {
      const ch = interaction.options.getChannel('kanal');
      gc.antiscam.logChannel = ch.id;
      saveConfig();

      return interaction.reply({
        embeds: [embed('#2ed573', '✅ Logi AntiScam ustawione', `Kanał logów → <#${ch.id}>`)],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

// ── scamdomains ──────────────────────────────────────────────────────
if (commandName === 'scamdomains') {
  const sub = interaction.options.getSubcommand();

  if (!gc.antiscam) gc.antiscam = {};

  if (!gc.antiscam.blockedDomains) {
    gc.antiscam.blockedDomains = [...DEFAULT_BLOCKED_DOMAINS];
  } else {
    gc.antiscam.blockedDomains = normalizeBlockedDomains([
      ...DEFAULT_BLOCKED_DOMAINS,
      ...gc.antiscam.blockedDomains,
    ]);
  }

  if (sub === 'add') {
    const input = interaction.options.getString('domena');

    const domains = normalizeBlockedDomains(input.split(/[\s,\n]+/));

    let added = 0;
    const addedDomains = [];

    for (const domain of domains) {
      if (!gc.antiscam.blockedDomains.includes(domain)) {
        gc.antiscam.blockedDomains.push(domain);
        added++;
        addedDomains.push(domain);
      }
    }

    saveConfig();

    const preview = addedDomains.length
      ? addedDomains.slice(0, 25).map(d => `• \`${d}\``).join('\n')
      : 'Nie dodano nowych domen. Te domeny mogły już być na liście.';

    return interaction.reply({
      embeds: [embed(
        '#2ed573',
        '✅ Domeny dodane',
        `Dodano **${added}** nowych domen do bazy scam domen.\n\n${preview}${addedDomains.length > 25 ? '\n...i więcej' : ''}`
      )],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'remove') {
    const domain = normalizeDomainInput(interaction.options.getString('domena'));

    gc.antiscam.blockedDomains = gc.antiscam.blockedDomains.filter(d => d !== domain);
    saveConfig();

    return interaction.reply({
      embeds: [embed('#ff4757', '🗑️ Domena usunięta', `\`${domain}\` usunięto z bazy scam domen.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  if (sub === 'list') {
    gc.antiscam.blockedDomains = normalizeBlockedDomains(gc.antiscam.blockedDomains);
    saveConfig();

    const list = gc.antiscam.blockedDomains.length
      ? gc.antiscam.blockedDomains.map(d => `• \`${d}\``).join('\n')
      : 'Brak domen w bazie.';

    return interaction.reply({
      embeds: [embed('#ff6b00', '🌐 Scam domeny', list)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ── antiraid ──────────────────────────────────────────────────────────
if (commandName === 'antiraid') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on')  { gc.antiraid.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiRaid włączony',  'Ochrona aktywna.')],    flags: MessageFlags.Ephemeral }); }
    if (sub === 'off') { gc.antiraid.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ AntiRaid wyłączony', 'Ochrona wyłączona.')], flags: MessageFlags.Ephemeral }); }
    if (sub === 'set') {
      gc.antiraid.joinThreshold = interaction.options.getInteger('dolaczenia');
      gc.antiraid.joinInterval  = interaction.options.getInteger('czas') * 1000;
      const akcja = interaction.options.getString('akcja');
      if (akcja) gc.antiraid.action = akcja;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiRaid zaktualizowany', `Próg: ${gc.antiraid.joinThreshold} / ${gc.antiraid.joinInterval / 1000}s, akcja: ${gc.antiraid.action.toUpperCase()}`)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'lockdown') {
      const aktywny = interaction.options.getBoolean('aktywny');
      gc.antiraid.lockdownActive = aktywny;
      saveConfig();
      let failed = 0;
      for (const [, ch] of interaction.guild.channels.cache) {
        if (ch.type === ChannelType.GuildText) {
          await ch.permissionOverwrites.edit(interaction.guild.roles.everyone, {
            SendMessages: aktywny ? false : null,
          }).catch(() => { failed++; });
        }
      }
      return interaction.reply({ embeds: [embed(
        aktywny ? '#ff4757' : '#2ed573',
        aktywny ? '🔒 LOCKDOWN AKTYWNY' : '🔓 Lockdown wyłączony',
        aktywny ? 'Nikt nie może pisać na serwerze.' : 'Serwer wrócił do normalnego trybu.'
      )] });
    }
    if (sub === 'log') {
      gc.antiraid.logChannel = interaction.options.getChannel('kanal').id;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Logi ustawione', `AntiRaid → <#${gc.antiraid.logChannel}>`)], flags: MessageFlags.Ephemeral });
    }
  }

  // ── channelguard ──────────────────────────────────────────────────────
  if (commandName === 'channelguard') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on')  { gc.channelGuard.enabled = true; gc.channelGuard.blockNewChannels = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ Channel Guard włączony', 'Blokada aktywna.')],              flags: MessageFlags.Ephemeral }); }
    if (sub === 'off') { gc.channelGuard.blockNewChannels = false;                                  saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ Channel Guard wyłączony', 'Tworzenie kanałów dozwolone.')], flags: MessageFlags.Ephemeral }); }
    if (sub === 'whitelist') {
      const role = interaction.options.getRole('rola');
      if (!gc.channelGuard.whitelistedRoles.includes(role.id)) {
        gc.channelGuard.whitelistedRoles.push(role.id);
        saveConfig();
      }
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Rola dodana do whitelisty', `<@&${role.id}> może tworzyć kanały.`)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'log') {
      gc.channelGuard.logChannel = interaction.options.getChannel('kanal').id;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Logi ustawione', `Channel Guard → <#${gc.channelGuard.logChannel}>`)], flags: MessageFlags.Ephemeral });
    }
  }

  // ── warn ──────────────────────────────────────────────────────────────
  if (commandName === 'warn') {
    const user   = interaction.options.getUser('uzytkownik');
    const reason = interaction.options.getString('powod');
    if (!gc.warns[user.id]) gc.warns[user.id] = [];
    gc.warns[user.id].push({ reason, mod: interaction.user.tag, date: new Date().toISOString() });
    saveConfig();

    const count = gc.warns[user.id].length;
    await sendModLog(interaction.guild, `WARN (#${count})`, user, interaction.user, reason, '#ffa502');

    let extraMsg = '';
    try {
      const member = await interaction.guild.members.fetch(user.id);
      await member.send({ embeds: [embed(
        '#ffa502', `⚠️ Ostrzeżenie — ${interaction.guild.name}`,
        `Otrzymałeś/aś ostrzeżenie od moderatora.\n\nPowód: **${reason}**\nOstrzeżeń łącznie: **${count}**`
      )] }).catch(() => {});

      if (count === 3) {
        await member.timeout(30 * 60 * 1000, 'FenixExelent: 3 ostrzeżenia');
        await sendModLog(interaction.guild, 'AUTO-MUTE (3 warns)', user, client.user, '3 ostrzeżenia = 30 min mute', '#ff4757');
        extraMsg = '\n\n⚠️ Automatycznie wyciszony/a na 30 min!';
      } else if (count >= 5) {
        await member.kick('FenixExelent: 5 ostrzeżeń');
        await sendModLog(interaction.guild, 'AUTO-KICK (5 warns)', user, client.user, '5 ostrzeżeń = kick', '#ff0000');
        extraMsg = '\n\n🔴 Automatycznie wyrzucony/a (5 warnów)!';
      }
    } catch {}

    return interaction.reply({ embeds: [embed(
      '#ffa502', '⚠️ Ostrzeżenie wydane',
      `<@${user.id}> dostał/a ostrzeżenie.\nPowód: ${reason}\nŁącznie ostrzeżeń: ${count}${extraMsg}`,
    )], flags: MessageFlags.Ephemeral });
  }

  // ── warnings ──────────────────────────────────────────────────────────
  if (commandName === 'warnings') {
    const user  = interaction.options.getUser('uzytkownik');
    const warns = gc.warns[user.id] || [];
    if (!warns.length) {
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Brak ostrzeżeń', `<@${user.id}> nie ma żadnych ostrzeżeń.`)], flags: MessageFlags.Ephemeral });
    }
    const list = warns.map((w, i) =>
      `**${i + 1}.** ${w.reason} — *${w.mod}* | ${new Date(w.date).toLocaleDateString('pl-PL')}`
    ).join('\n');
    return interaction.reply({ embeds: [embed(
      '#ffa502', `⚠️ Ostrzeżenia — ${user.tag}`, list,
      [{ name: 'Łącznie', value: `${warns.length} ostrzeżeń`, inline: true }]
    )], flags: MessageFlags.Ephemeral });
  }

  // ── clearwarns ────────────────────────────────────────────────────────
  if (commandName === 'clearwarns') {
    const user  = interaction.options.getUser('uzytkownik');
    const count = (gc.warns[user.id] || []).length;
    gc.warns[user.id] = [];
    saveConfig();
    await sendModLog(interaction.guild, 'CLEAR WARNS', user, interaction.user, `Usunięto ${count} ostrzeżeń`, '#2ed573');
    return interaction.reply({ embeds: [embed('#2ed573', '🗑️ Ostrzeżenia wyczyszczone', `Usunięto **${count}** ostrzeżeń dla <@${user.id}>.`)], flags: MessageFlags.Ephemeral });
  }

  // ── unmute ────────────────────────────────────────────────────────────
  if (commandName === 'unmute') {
    const user = interaction.options.getUser('uzytkownik');
    try {
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(null);
      mutedUsers.delete(user.id);
      await sendModLog(interaction.guild, 'UNMUTE', user, interaction.user, 'Ręczne zdjęcie muta', '#2ed573');
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Muta zdjęty', `Zdjęto muta z <@${user.id}>.`)], flags: MessageFlags.Ephemeral });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie udało się zdjąć muta.')], flags: MessageFlags.Ephemeral });
    }
  }

  // ── kick ──────────────────────────────────────────────────────────────
  if (commandName === 'kick') {
    const user   = interaction.options.getUser('uzytkownik');
    const reason = interaction.options.getString('powod') || 'Brak powodu';
    try {
      const member = await interaction.guild.members.fetch(user.id);
      if (!member.kickable) return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie mogę wyrzucić tego użytkownika (wyższe uprawnienia).')], flags: MessageFlags.Ephemeral });
      await member.kick(reason);
      await sendModLog(interaction.guild, 'KICK', user, interaction.user, reason, '#ff6b00');
      return interaction.reply({ embeds: [embed('#ff6b00', '👢 Użytkownik wyrzucony', `<@${user.id}> został/a wyrzucony/a.\nPowód: ${reason}`)], flags: MessageFlags.Ephemeral });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie udało się wyrzucić użytkownika.')], flags: MessageFlags.Ephemeral });
    }
  }

  // ── ban ───────────────────────────────────────────────────────────────
  if (commandName === 'ban') {
    const user   = interaction.options.getUser('uzytkownik');
    const reason = interaction.options.getString('powod') || 'Brak powodu';
    try {
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (member && !member.bannable) return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie mogę zbanować tego użytkownika (wyższe uprawnienia).')], flags: MessageFlags.Ephemeral });
      await interaction.guild.members.ban(user.id, { reason });
      await sendModLog(interaction.guild, 'BAN', user, interaction.user, reason, '#ff0000');
      return interaction.reply({ embeds: [embed('#ff0000', '🔨 Użytkownik zbanowany', `<@${user.id}> został/a zbanowany/a.\nPowód: ${reason}`)], flags: MessageFlags.Ephemeral });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie udało się zbanować użytkownika.')], flags: MessageFlags.Ephemeral });
    }
  }

  // ── unban ─────────────────────────────────────────────────────────────
  if (commandName === 'unban') {
    const id = interaction.options.getString('id');
    try {
      await interaction.guild.members.unban(id);
      await sendModLog(interaction.guild, 'UNBAN', { tag: `ID: ${id}`, id }, interaction.user, 'Ręczne odbanowanie', '#2ed573');
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Odbanowano', `Użytkownik o ID \`${id}\` został/a odbanowany/a.`)], flags: MessageFlags.Ephemeral });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie znaleziono bana lub nieprawidłowe ID.')], flags: MessageFlags.Ephemeral });
    }
  }

  // ── verification ──────────────────────────────────────────────────────
  if (commandName === 'verification') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const role = interaction.options.getRole('rola');
      const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);

      if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply('❌ Bot potrzebuje uprawnienia **Zarządzanie rolami**.');
      }

      if (role.managed || role.id === interaction.guild.roles.everyone.id) {
        return interaction.editReply('❌ Wybierz zwykłą rolę serwerową, a nie rolę integracji lub @everyone.');
      }

      if (botMember.roles.highest.comparePositionTo(role) <= 0) {
        return interaction.editReply(
          `❌ Rola bota musi znajdować się **wyżej** niż ${role} w ustawieniach ról.`
        );
      }

      gc.verification.roleId = role.id;

      let unverifiedRole = gc.verification.unverifiedRoleId
        ? interaction.guild.roles.cache.get(gc.verification.unverifiedRoleId)
        : null;

      if (!unverifiedRole) {
        unverifiedRole = interaction.guild.roles.cache.find(
          r => ['niezweryfikowany', 'unverified'].includes(r.name.toLowerCase())
        );
      }

      if (!unverifiedRole) {
        unverifiedRole = await interaction.guild.roles.create({
          name: 'Niezweryfikowany',
          colors: { primaryColor: '#747d8c' },
          reason: 'FenixExelent Verification',
        }).catch(() => null);
      }

      if (!unverifiedRole) {
        return interaction.editReply('❌ Nie udało się utworzyć roli **Niezweryfikowany**.');
      }

      if (botMember.roles.highest.comparePositionTo(unverifiedRole) <= 0) {
        return interaction.editReply(
          `❌ Rola bota musi znajdować się **wyżej** niż ${unverifiedRole}.`
        );
      }

      gc.verification.unverifiedRoleId = unverifiedRole.id;

      let verifyChannel = gc.verification.channelId
        ? interaction.guild.channels.cache.get(gc.verification.channelId)
        : null;

      if (!verifyChannel) {
        const category = await getOrCreateCategory(interaction.guild, '🔐 WERYFIKACJA');
        verifyChannel = await getOrCreateText(
          interaction.guild,
          category,
          '✅│weryfikacja',
          [{ id: interaction.guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }]
        );
        gc.verification.channelId = verifyChannel.id;
      }

      await interaction.guild.channels.fetch().catch(() => {});
      for (const [, ch] of interaction.guild.channels.cache) {
        if (![ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory].includes(ch.type)) continue;

        if (ch.id === verifyChannel.id) {
          await ch.permissionOverwrites.edit(unverifiedRole, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
          }).catch(() => {});
        } else {
          await ch.permissionOverwrites.edit(unverifiedRole, {
            ViewChannel: false,
          }).catch(() => {});
        }
      }

      gc.verification.enabled = true;
      saveConfig();

      await verifyChannel.bulkDelete(10).catch(() => {});
      await sendVerifyPanel(verifyChannel).catch(() => {});

      return interaction.editReply({
        embeds: [embed(
          '#2ed573',
          '✅ Weryfikacja skonfigurowana i włączona',
          `Rola po weryfikacji: <@&${role.id}>\n` +
          `Rola przed weryfikacją: <@&${unverifiedRole.id}>\n` +
          `Panel: <#${verifyChannel.id}>`
        )],
      });
    }

    if (sub === 'on') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await ensureVerificationForAntiAlt(interaction.guild, gc);

      if (!result.ok) {
        return interaction.editReply(
          '❌ Nie udało się uruchomić weryfikacji. Bot potrzebuje uprawnień **Zarządzanie rolami** i **Zarządzanie kanałami**.'
        );
      }

      gc.verification.enabled = true;
      saveConfig();

      return interaction.editReply({
        embeds: [embed(
          '#2ed573',
          '✅ Weryfikacja włączona',
          `System jest aktywny. Panel: <#${result.verifyChannel.id}>`
        )],
      });
    }

    if (sub === 'off') {
      gc.verification.enabled = false;
      saveConfig();
      return interaction.reply({
        embeds: [embed('#ff4757', '❌ Weryfikacja wyłączona', 'System weryfikacji jest nieaktywny.')],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'panel') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = await ensureVerificationForAntiAlt(interaction.guild, gc);
      if (!result.ok || !gc.verification.roleId) {
        return interaction.editReply(
          '❌ Najpierw skonfiguruj rolę przez `/verification setup rola:@Rola`.'
        );
      }

      const channel = result.verifyChannel || interaction.channel;
      await channel.bulkDelete(10).catch(() => {});
      await sendVerifyPanel(channel);
      gc.verification.enabled = true;
      gc.verification.channelId = channel.id;
      saveConfig();

      return interaction.editReply({
        embeds: [embed('#2ed573', '✅ Panel wysłany', `Panel weryfikacyjny wysłany na <#${channel.id}>.`)],
      });
    }
  }

  // ── ticket ────────────────────────────────────────────────────────────
  if (commandName === 'ticket') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      const role   = interaction.options.getRole('rola');
      const logsCh = interaction.options.getChannel('logi');
      gc.tickets.supportRoleId = role.id;
      if (logsCh) gc.tickets.logChannelId = logsCh.id;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Tickety skonfigurowane', `Rola supportu: <@&${role.id}>${logsCh ? `\nLogi: <#${logsCh.id}>` : ''}`)], flags: MessageFlags.Ephemeral });
    }
    if (sub === 'on')  { gc.tickets.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ Tickety włączone',  'System ticketów aktywny.')],     flags: MessageFlags.Ephemeral }); }
    if (sub === 'off') { gc.tickets.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ Tickety wyłączone', 'System ticketów nieaktywny.')], flags: MessageFlags.Ephemeral }); }
    if (sub === 'panel') {
      await sendTicketPanel(interaction.channel);
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Panel wysłany', `Panel ticketów na <#${interaction.channel.id}>.`)], flags: MessageFlags.Ephemeral });
    }
  }
  // ── botserver ──────────────────────────────────────────────────
  if (commandName === 'botserver') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await setupOfficialBotServer(interaction.guild);

      return interaction.editReply({
        content: '✅ Oficjalny serwer supportowy FenixExelent został skonfigurowany.',
      });
    }

    if (sub === 'refresh') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await refreshOfficialBotServer(interaction.guild);

      return interaction.editReply({
        content: '✅ Embedy informacyjne PL/EN zostały odświeżone. Kanały zostały zachowane.',
      });
    }
  }

}


async function clearChannelMessagesByName(guild, channelNames) {
  for (const name of channelNames) {
    const ch = guild.channels.cache.find(c =>
      c.type === ChannelType.GuildText && c.name === name
    );

    if (!ch) continue;

    try {
      const messages = await ch.messages.fetch({ limit: 100 });
      if (messages.size > 0) {
        await ch.bulkDelete(messages, true).catch(async () => {
          for (const [, msg] of messages) {
            await msg.delete().catch(() => {});
          }
        });
      }
    } catch (err) {
      logger.error(`Refresh error for #${name}:`, err.message);
    }
  }
}

async function refreshOfficialBotServer(guild) {
  const infoChannels = [
    '👋│witaj',
    '📜│regulamin',
    '📢│ogłoszenia',
    '📜│changelog',
    '📥│instalacja-bota',
    '❓│faq',
    '🤖│komendy',
    '🚨│zgłoszenia-scam',
    '🦠│nowe-zagrożenia',
    '⚠️│alerty-bezpieczeństwa',
  ];

  await clearChannelMessagesByName(guild, infoChannels);
  await setupOfficialBotServer(guild);
}


async function setupOfficialBotServer(guild) {
  const everyone = guild.roles.everyone.id;

  const staffRoles = guild.roles.cache
    .filter(role =>
      role.permissions.has(PermissionFlagsBits.Administrator) ||
      role.permissions.has(PermissionFlagsBits.ManageGuild) ||
      role.permissions.has(PermissionFlagsBits.ManageChannels)
    )
    .map(role => role.id);

  const readOnly = [
    {
      id: everyone,
      deny: [PermissionFlagsBits.SendMessages],
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
    },
  ];

  const publicText = [
    {
      id: everyone,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  const mediaText = [
    {
      id: everyone,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  const staffPerms = [
    {
      id: everyone,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...staffRoles.map(roleId => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    })),
  ];

  // Kategorie
  const info = await getOrCreateCategory(guild, '📢 INFORMACJE');
  const security = await getOrCreateCategory(guild, '🛡️ SECURITY');
  const support = await getOrCreateCategory(guild, '🆘 SUPPORT');
  const community = await getOrCreateCategory(guild, '👥 SPOŁECZNOŚĆ');
  const staff = await getOrCreateCategory(guild, '👑 STAFF');

  await info.permissionOverwrites.set(readOnly).catch(() => {});
  await security.permissionOverwrites.set(publicText).catch(() => {});
  await support.permissionOverwrites.set(publicText).catch(() => {});
  await community.permissionOverwrites.set(publicText).catch(() => {});
  await staff.permissionOverwrites.set(staffPerms).catch(() => {});

  // 📢 INFORMACJE
  const welcome = await getOrCreateText(guild, info, '👋│witaj', readOnly);
  const rules = await getOrCreateText(guild, info, '📜│regulamin', readOnly);
  const announcements = await getOrCreateText(guild, info, '📢│ogłoszenia', readOnly);
  const changelog = await getOrCreateText(guild, info, '📜│changelog', readOnly);
  const install = await getOrCreateText(guild, info, '📥│instalacja-bota', readOnly);
  const faq = await getOrCreateText(guild, info, '❓│faq', readOnly);
  const commands = await getOrCreateText(guild, info, '🤖│komendy', readOnly);

  // 🛡️ SECURITY
  await getOrCreateText(guild, security, '🌐│scam-domain', publicText);
  const reportScam = await getOrCreateText(guild, security, '🚨│zgłoszenia-scam', publicText);
  const newThreats = await getOrCreateText(guild, security, '🦠│nowe-zagrożenia', readOnly);
  await getOrCreateText(guild, security, '🔍│analiza-linków', publicText);
  const securityAlerts = await getOrCreateText(guild, security, '⚠️│alerty-bezpieczeństwa', readOnly);

  // 🆘 SUPPORT
  await getOrCreateText(guild, support, '🎫│support', publicText);
  await getOrCreateText(guild, support, '❓│pomoc', publicText);
  await getOrCreateText(guild, support, '🐞│bug-report', publicText);
  await getOrCreateText(guild, support, '💡│propozycje', publicText);
  await getOrCreateText(guild, support, '🔧│pomoc-techniczna', publicText);

  // 👥 SPOŁECZNOŚĆ
  await getOrCreateText(guild, community, '💬│chat', publicText);
  await getOrCreateText(guild, community, '📸│media', mediaText);
  await getOrCreateText(guild, community, '🎉│off-topic', publicText);

  // 👑 STAFF
  const botLogs = await getOrCreateText(guild, staff, '📋│logi-bota', staffPerms);
  const antiscamAlerts = await getOrCreateText(guild, staff, '🚨│alerty-antiscam', staffPerms);
  await getOrCreateText(guild, staff, '📝│moderacja', staffPerms);
  await getOrCreateText(guild, staff, '🔒│zarządzanie', staffPerms);

  const gc = getGuildConfig(guild.id);
  gc.modLog.channelId = botLogs.id;
  if (!gc.antiscam) gc.antiscam = {};
  gc.antiscam.logChannel = antiscamAlerts.id;
  saveConfig();

  await welcome.send({
    embeds: [embed(
      '#ff6b00',
      '🔥 FenixExelentSecurity Support / Welcome',
      `🇵🇱 **Polski**

Witaj na oficjalnym serwerze supportowym bota **FenixExelentSecurity**.

📜 Przeczytaj regulamin.
🤖 Sprawdź komendy.
🆘 Użyj kanałów supportu, jeśli potrzebujesz pomocy.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

Welcome to the official **FenixExelentSecurity** bot support server.

📜 Read the rules.
🤖 Check the commands.
🆘 Use support channels if you need help.`
    )]
  }).catch(() => {});

  await rules.send({
    embeds: [embed(
      '#ff6b00',
      '📜 Regulamin / Rules',
      `🇵🇱 **Polski**

• Szanuj innych użytkowników.
• Zakaz spamu i floodowania.
• Zakaz reklam bez zgody administracji.
• Zakaz treści NSFW.
• Zakaz wysyłania scam linków i phishingu.
• Decyzje administracji są ostateczne.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

• Respect other users.
• No spam or flooding.
• No advertising without staff permission.
• No NSFW content.
• No scam links or phishing.
• Staff decisions are final.`
    )]
  }).catch(() => {});

  await announcements.send({
    embeds: [embed(
      '#ff6b00',
      '📢 Ogłoszenia / Announcements',
      `🇵🇱 **Polski**

Tutaj administracja będzie publikować najważniejsze informacje o bocie i serwerze.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

Staff will post the most important bot and server announcements here.`
    )]
  }).catch(() => {});

  await changelog.send({
    embeds: [embed(
      '#ff6b00',
      '📜 Changelog / Updates',
      `🇵🇱 **Polski**

Tutaj będą pojawiać się zmiany, poprawki i nowe funkcje bota.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

Bot changes, fixes and new features will be posted here.`
    )]
  }).catch(() => {});

  await install.send({
    embeds: [embed(
      '#ff6b00',
      '📥 Instalacja bota / Bot Installation',
      `🇵🇱 **Polski**

1. Użyj zaproszenia bota.
2. Nadaj wymagane uprawnienia.
3. Uruchom \`/setup\`.
4. Skonfiguruj moduły: \`/antispam\`, \`/antiraid\`, \`/verification\`, \`/ticket\`.
5. Sprawdź \`/security\` oraz \`/status\`.

🌐 **Dashboard:**
https://fenixexelent.onrender.com

🔗 **Dodaj bota:**
https://fenixexelent.onrender.com/invite

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

1. Invite the bot.
2. Grant the required permissions.
3. Run \`/setup\`.
4. Configure modules: \`/antispam\`, \`/antiraid\`, \`/verification\`, \`/ticket\`.
5. Check \`/security\` and \`/status\`.

🌐 **Dashboard:**
https://fenixexelent.onrender.com

🔗 **Invite bot:**
https://fenixexelent.onrender.com/invite`
    )]
  }).catch(() => {});

  await faq.send({
    embeds: [embed(
      '#ff6b00',
      '❓ FAQ',
      `🇵🇱 **Polski**

**Jak dodać bota?**
Użyj linku z kanału \`instalacja-bota\`.

**Jak zgłosić problem?**
Użyj kanału \`pomoc\` albo ticketów.

**Jak zgłosić scam?**
Użyj kanału \`zgłoszenia-scam\`.

**Gdzie są komendy?**
Sprawdź kanał \`komendy\`.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

**How do I invite the bot?**
Use the link from the \`instalacja-bota\` channel.

**How do I report a problem?**
Use the \`pomoc\` channel or tickets.

**How do I report a scam?**
Use the \`zgłoszenia-scam\` channel.

**Where are the commands?**
Check the \`komendy\` channel.`
    )]
  }).catch(() => {});

  await commands.send({
    embeds: [embed(
      '#ff6b00',
      '🤖 Komendy FenixExelentSecurity / Commands',
      [
        '🇵🇱 **Polski**',
        '',
        '`/help` — lista komend',
        '`/dashboard` — panel webowy',
        '`/setup` — podstawowy setup serwera',
        '`/security` — panel bezpieczeństwa',
        '`/status` — status modułów',
        '`/stats` — odśwież statystyki',
        '`/refreshbot` — odśwież bota na wszystkich serwerach',
        '`/ocrscan on/off/status/strict` — OCR skan scam screenów',
        '`/antialt on/off/set/status` — ochrona przed świeżymi kontami',
        '`/emergency on/off/status` — tryb awaryjny serwera',
        '`/reportscam` — zgłoś scam z przyciskami dla staffu',
        '`/antispam on/off/set/log`',
        '`/antiraid on/off/set/lockdown/log`',
        '`/channelguard on/off/whitelist/log`',
        '`/verification setup/on/off/panel`',
        '`/ticket setup/on/off/panel`',
        '`/scamdomains add/remove/list`',
        '`/warn`, `/warnings`, `/clearwarns`, `/kick`, `/ban`, `/unban`, `/unmute`',
        '`/botserver setup` — oficjalny setup support serwera',
        '',
        '━━━━━━━━━━━━━━━━━━━━',
        '',
        '🇬🇧 **English**',
        '',
        '`/help` — command list',
        '`/dashboard` — web dashboard',
        '`/setup` — basic server setup',
        '`/security` — security panel',
        '`/status` — module status',
        '`/stats` — refresh stats',
        '`/refreshbot` — refresh bot on all servers',
        '`/ocrscan on/off/status/strict` — OCR scam screenshot scan',
        '`/antialt on/off/set/status` — new account protection',
        '`/emergency on/off/status` — server emergency mode',
        '`/reportscam` — report scam with staff actions',
        '`/antispam on/off/set/log`',
        '`/antiraid on/off/set/lockdown/log`',
        '`/channelguard on/off/whitelist/log`',
        '`/verification setup/on/off/panel`',
        '`/ticket setup/on/off/panel`',
        '`/scamdomains add/remove/list`',
        '`/warn`, `/warnings`, `/clearwarns`, `/kick`, `/ban`, `/unban`, `/unmute`',
        '`/botserver setup` — official support server setup'
      ].join('\n')
    )]
  }).catch(() => {});

  await reportScam.send({
    embeds: [embed(
      '#ff6b00',
      '🚨 Zgłoszenia scam / Scam Reports',
      `🇵🇱 **Polski**

Wysyłaj tutaj podejrzane domeny, linki i screeny.
Administracja sprawdzi zgłoszenie.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

Send suspicious domains, links and screenshots here.
Staff will review the report.`
    )]
  }).catch(() => {});

  await newThreats.send({
    embeds: [embed(
      '#ff6b00',
      '🦠 Nowe zagrożenia / New Threats',
      `🇵🇱 **Polski**

Tutaj będą publikowane nowe typy scamów, phishingu i zagrożeń dla serwerów Discord.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

New scam, phishing and Discord server security threats will be posted here.`
    )]
  }).catch(() => {});

  await securityAlerts.send({
    embeds: [embed(
      '#ff4757',
      '⚠️ Alerty bezpieczeństwa / Security Alerts',
      `🇵🇱 **Polski**

Kanał informacyjny dla ważnych alertów bezpieczeństwa.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**

Important security alerts and warnings will be posted here.`
    )]
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
//  VERIFICATION PANEL
// ═══════════════════════════════════════════════════════════════════════════
async function sendVerifyPanel(channel) {

  const verifyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_btn')
      .setLabel('✅ Verify / Zweryfikuj się')
      .setStyle(ButtonStyle.Success)
  );
  const components = [verifyRow];
  const extraDescription = '';

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor('#ff6b00')
      .setTitle('✅ Weryfikacja / Verification — FenixExelent')
      .setDescription(`🇵🇱 **Polski**
Aby uzyskać dostęp do serwera, kliknij przycisk poniżej.

📜 Upewnij się, że przeczytałeś/aś regulamin.
Klikając przycisk, potwierdzasz akceptację zasad serwera.

━━━━━━━━━━━━━━━━━━━━

🇬🇧 **English**
To access the server, click the button below.

📜 Make sure you have read the rules.
By clicking the button, you confirm that you accept the server rules.${extraDescription}`)
      .setFooter({ text: 'FenixExelent 🔥' })
      .setTimestamp()
    ],
    components,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  TICKET PANEL
// ═══════════════════════════════════════════════════════════════════════════
async function sendTicketPanel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_open')
      .setLabel('🎫 Otwórz Ticket')
      .setStyle(ButtonStyle.Primary),
  );
  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor('#ff6b00')
      .setTitle('🎫 System Ticketów — FenixExelent')
      .setDescription(
        'Potrzebujesz pomocy? Masz pytanie lub problem?\n\n' +
        'Kliknij **Otwórz Ticket** poniżej, a nasz zespół supportu się tobą zajmie.\n\n' +
        '⚠️ Nie nadużywaj systemu ticketów.'
      )
      .setFooter({ text: 'FenixExelent 🔥 | Support' })
      .setTimestamp()
    ],
    components: [row],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  BUTTON INTERACTIONS
// ═══════════════════════════════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.guild) return;

  const gc = getGuildConfig(interaction.guild.id);

  try {
    await handleButton(interaction, gc);
  } catch (err) {
    logger.buttonError(err, interaction);
    const errMsg = { content: '❌ Wystąpił błąd.', flags: MessageFlags.Ephemeral };
    if (!interaction.replied && !interaction.deferred) await interaction.reply(errMsg).catch(() => {});
  }
});

async function handleButton(interaction, gc) {

  if (interaction.customId.startsWith('appeal:')) {
    if (!isStaffMember(interaction.member, gc)) {
      return interaction.reply({ content: '❌ Tylko staff może obsłużyć appeal.', flags: MessageFlags.Ephemeral });
    }
    const [, action, appealId] = interaction.customId.split(':');
    const appeals = ensureAppeals(gc);
    const appeal = appeals.cases?.[appealId];
    if (!appeal) return interaction.reply({ content: '❌ Appeal nie istnieje albo wygasł.', flags: MessageFlags.Ephemeral });

    let result = 'Zaktualizowano appeal.';
    if (action === 'accept') {
      appeal.status = 'accepted';
      const member = await interaction.guild.members.fetch(appeal.userId).catch(() => null);
      if (member) await member.timeout(null, `Appeal accepted by ${interaction.user.tag}`).catch(() => {});
      result = `✅ Appeal zaakceptowany. Zdjęto timeout, jeśli był aktywny.`;
    }
    if (action === 'reject') {
      appeal.status = 'rejected';
      result = '❌ Appeal odrzucony.';
    }
    if (action === 'more') {
      appeal.status = 'needs_more_info';
      result = '📝 Oznaczono appeal jako wymagający dodatkowych informacji.';
    }
    appeal.reviewedBy = interaction.user.id;
    appeal.reviewedAt = new Date().toISOString();
    saveConfig();
    await interaction.message.edit({ components: buildDisabledAppealButtons(appealId) }).catch(() => {});
    return interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId.startsWith('scamreport:')) {
    if (!isStaffMember(interaction.member, gc)) {
      return interaction.reply({ content: '❌ Tylko staff może obsłużyć zgłoszenie scam.', flags: MessageFlags.Ephemeral });
    }

    const [, action, reportId] = interaction.customId.split(':');
    const report = scamReports.get(reportId) || gc.scamReports?.[reportId];
    if (!report) {
      return interaction.reply({ content: '❌ To zgłoszenie wygasło po restarcie bota albo nie istnieje.', flags: MessageFlags.Ephemeral });
    }

    let result = 'Akcja wykonana.';

    if (action === 'block') {
      if (!report.domain) {
        return interaction.reply({ content: '❌ W zgłoszeniu nie ma wykrytej domeny do dodania.', flags: MessageFlags.Ephemeral });
      }
      if (!gc.antiscam.blockedDomains) gc.antiscam.blockedDomains = [];
      gc.antiscam.blockedDomains = normalizeBlockedDomains([...DEFAULT_BLOCKED_DOMAINS, ...gc.antiscam.blockedDomains, report.domain]);
      saveConfig();
      result = `✅ Dodano domenę \`${report.domain}\` do blacklisty.`;
    }

    if (action === 'mute') {
      if (!report.targetId) {
        return interaction.reply({ content: '❌ W zgłoszeniu nie wskazano użytkownika do muta.', flags: MessageFlags.Ephemeral });
      }
      const member = await interaction.guild.members.fetch(report.targetId).catch(() => null);
      if (!member) return interaction.reply({ content: '❌ Nie znaleziono użytkownika na serwerze.', flags: MessageFlags.Ephemeral });
      await member.timeout((gc.antiscam?.muteMinutes || 60) * 60 * 1000, `FenixExelent Scam Report: ${report.domain || report.link || reportId}`).catch(() => {});
      addRisk(gc, report.targetId, 25, `Scam report mute: ${report.domain || report.link || reportId}`, { type: 'reportscam-mute' });
      saveConfig();
      result = `🔇 Wyciszono <@${report.targetId}>.`;
    }

    if (action === 'ban') {
      if (!report.targetId) {
        return interaction.reply({ content: '❌ W zgłoszeniu nie wskazano użytkownika do bana.', flags: MessageFlags.Ephemeral });
      }
      await interaction.guild.members.ban(report.targetId, { reason: `FenixExelent Scam Report: ${report.domain || report.link || reportId}` }).catch(() => {});
      addRisk(gc, report.targetId, 40, `Scam report ban: ${report.domain || report.link || reportId}`, { type: 'reportscam-ban' });
      saveConfig();
      result = `🔨 Zbanowano użytkownika <@${report.targetId}>.`;
    }

    if (action === 'reject') {
      result = '❌ Zgłoszenie odrzucone.';
    }

    scamReports.delete(reportId);
    if (gc.scamReports) delete gc.scamReports[reportId];
    saveConfig();
    await interaction.message.edit({ components: buildDisabledScamReportButtons(reportId) }).catch(() => {});
    return interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
  }

  // ── Status Button ──
  if (interaction.customId === 'status_btn') {
    return interaction.reply({
      embeds: [embed(
        '#ff6b00', '📊 Status Modułów', 'Aktualny status ochrony serwera',
        [
          { name: 'AntiSpam',    value: gc.antispam.enabled               ? '✅ Aktywny'  : '❌ Wyłączony', inline: true },
          { name: 'AntiRaid',    value: gc.antiraid.enabled               ? '✅ Aktywny'  : '❌ Wyłączony', inline: true },
          { name: 'ChanGuard',   value: gc.channelGuard.blockNewChannels  ? '✅ Blokada'  : '❌ Wyłączony', inline: true },
          { name: 'Weryfikacja', value: gc.verification.enabled           ? '✅ Aktywna'  : '❌ Wyłączona', inline: true },
          { name: 'Tickety',     value: gc.tickets.enabled                ? '✅ Aktywne'  : '❌ Wyłączone', inline: true },
          { name: 'Lockdown',    value: gc.antiraid.lockdownActive         ? '🔴 AKTYWNY' : '🟢 Wyłączony', inline: true },
        ]
      )],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── Lockdown Toggle ──
  if (interaction.customId === 'lockdown_toggle') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Brak uprawnień administratora.', flags: MessageFlags.Ephemeral });
    }
    const aktywny = !gc.antiraid.lockdownActive;
    gc.antiraid.lockdownActive = aktywny;
    saveConfig();
    for (const [, ch] of interaction.guild.channels.cache) {
      if (ch.type === ChannelType.GuildText) {
        await ch.permissionOverwrites.edit(interaction.guild.roles.everyone, {
          SendMessages: aktywny ? false : null,
        }).catch(() => {});
      }
    }
    return interaction.reply({ embeds: [embed(
      aktywny ? '#ff4757' : '#2ed573',
      aktywny ? '🔒 LOCKDOWN WŁĄCZONY' : '🔓 Lockdown wyłączony',
      aktywny ? 'Nikt nie może pisać.' : 'Serwer w normalnym trybie.'
    )], flags: MessageFlags.Ephemeral });
  }

  // ── Verification Button ──
  if (interaction.customId === 'verify_btn') {
    if (!gc.verification?.enabled) {
      return interaction.reply({
        content: '❌ Weryfikacja jest aktualnie wyłączona. Administrator musi użyć `/verification on`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const role = gc.verification.roleId
      ? interaction.guild.roles.cache.get(gc.verification.roleId)
      : null;

    if (!role) {
      return interaction.reply({
        content: '❌ Rola weryfikacji nie istnieje. Administrator musi użyć `/verification setup`.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return interaction.reply({
        content: '❌ Bot nie ma uprawnienia **Zarządzanie rolami**.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (botMember.roles.highest.comparePositionTo(role) <= 0) {
      return interaction.reply({
        content: `❌ Rola bota musi być wyżej niż ${role}. Poproś administratora o poprawienie kolejności ról.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);

      if (member.roles.cache.has(role.id)) {
        if (gc.verification.unverifiedRoleId) {
          await member.roles.remove(gc.verification.unverifiedRoleId).catch(() => {});
        }
        return interaction.reply({
          content: '✅ Jesteś już zweryfikowany/a!',
          flags: MessageFlags.Ephemeral,
        });
      }

      await member.roles.add(role, 'FenixExelent: weryfikacja przyciskiem');

      if (gc.verification.unverifiedRoleId) {
        await member.roles.remove(
          gc.verification.unverifiedRoleId,
          'FenixExelent: użytkownik zweryfikowany'
        ).catch(() => {});
      }

      return interaction.reply({
        embeds: [embed(
          '#2ed573',
          '✅ Zweryfikowano!',
          `Witaj na **${interaction.guild.name}**! Masz teraz pełny dostęp do serwera. 🔥`
        )],
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      logger.error('Verify error:', err);
      return interaction.reply({
        content: `❌ Nie udało się nadać roli. Sprawdź uprawnienia i kolejność ról bota. (${err.code || 'unknown'})`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // ── Ticket Open ──
  if (interaction.customId === 'ticket_open') {
    if (!gc.tickets.enabled) {
      return interaction.reply({ content: '❌ System ticketów jest wyłączony.', flags: MessageFlags.Ephemeral });
    }
    const userId = interaction.user.id;
    if (gc.tickets.openTickets[userId]) {
      const existing = interaction.guild.channels.cache.get(gc.tickets.openTickets[userId]);
      if (existing) return interaction.reply({ content: `❌ Masz już otwarty ticket <#${existing.id}>`, flags: MessageFlags.Ephemeral });
      delete gc.tickets.openTickets[userId];
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const overwrites = [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      ];
      if (gc.tickets.supportRoleId) {
        overwrites.push({ id: gc.tickets.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
      }
      const safeName = interaction.user.username.toLowerCase().replace(/\s+/g, '-');
      const ticketCh = await interaction.guild.channels.create({
        name:                `ticket-${safeName}`,
        type:                ChannelType.GuildText,
        parent:              gc.tickets.categoryId || null,
        permissionOverwrites: overwrites,
        topic:               `Ticket użytkownika ${interaction.user.tag} | ID: ${userId}`,
      });

      gc.tickets.openTickets[userId] = ticketCh.id;
      saveConfig();

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('🔒 Zamknij Ticket').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('ticket_claim').setLabel('🙋 Przejmij').setStyle(ButtonStyle.Secondary),
      );
      await ticketCh.send({
        content: `${interaction.user}${gc.tickets.supportRoleId ? ` <@&${gc.tickets.supportRoleId}>` : ''}`,
        embeds: [embed(
          '#ff6b00', '🎫 Ticket Otwarty',
          `Cześć ${interaction.user}! Opisz swój problem, a nasz support niedługo się pojawi.\n\nAby zamknąć ticket kliknij przycisk poniżej.`,
          [{ name: 'Otwarty przez', value: interaction.user.tag, inline: true }]
        )],
        components: [closeRow],
      });

      if (gc.tickets.logChannelId) {
        await sendLog(interaction.guild, gc.tickets.logChannelId, embed(
          '#2ed573', '🎫 Ticket Otwarty',
          `Nowy ticket od ${interaction.user.tag}`,
          [
            { name: 'Użytkownik', value: `<@${userId}>`,       inline: true },
            { name: 'Kanał',      value: `<#${ticketCh.id}>`,  inline: true },
          ]
        ));
      }
      return interaction.editReply({ content: `✅ Ticket otwarty! <#${ticketCh.id}>` });
    } catch (err) {
      logger.error('Ticket open error:', err);
      return interaction.editReply({ content: '❌ Nie udało się otworzyć ticketu. Sprawdź uprawnienia bota.' });
    }
  }

  // ── Ticket Close ──
  if (interaction.customId === 'ticket_close') {
    const canClose =
      interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) ||
      (gc.tickets.supportRoleId && interaction.member.roles.cache.has(gc.tickets.supportRoleId)) ||
      Object.values(gc.tickets.openTickets).includes(interaction.channel.id);

    if (!canClose) return interaction.reply({ content: '❌ Brak uprawnień do zamknięcia.', flags: MessageFlags.Ephemeral });

    const ownerId = Object.keys(gc.tickets.openTickets).find(k => gc.tickets.openTickets[k] === interaction.channel.id);
    if (ownerId) { delete gc.tickets.openTickets[ownerId]; saveConfig(); }

    if (gc.tickets.logChannelId) {
      await sendLog(interaction.guild, gc.tickets.logChannelId, embed(
        '#ff4757', '🔒 Ticket Zamknięty',
        `Ticket **${interaction.channel.name}** zamknięty przez ${interaction.user.tag}`,
        [{ name: 'Zamknięty przez', value: interaction.user.tag, inline: true }]
      ));
    }
    await interaction.reply({ content: '🔒 Ticket zostanie zamknięty za 5 sekund...' });
    setTimeout(() => interaction.channel.delete('Ticket zamknięty').catch(() => {}), 5000);
  }

  // ── Ticket Claim ──
  if (interaction.customId === 'ticket_claim') {
    const hasSupport = gc.tickets.supportRoleId && interaction.member.roles.cache.has(gc.tickets.supportRoleId);
    const hasManage  = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);
    if (!hasSupport && !hasManage) {
      return interaction.reply({ content: '❌ Tylko support może przejąć ticket.', flags: MessageFlags.Ephemeral });
    }
    const safeName = interaction.user.username.toLowerCase().replace(/\s+/g, '-');
    await interaction.channel.setName(`ticket-${safeName}-claimed`).catch(() => {});
    return interaction.reply({ embeds: [embed('#2ed573', '🙋 Ticket Przejęty', `Ticket został przejęty przez ${interaction.user}.`)] });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  DASHBOARD (Web Panel)
// ═══════════════════════════════════════════════════════════════════════════
// Dashboard HTTP is implemented in src/dashboard/server.js.
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  try { client.destroy(); } catch {}
  if (dashboardHttpServer) {
    await new Promise(resolve => dashboardHttpServer.close(() => resolve())).catch(() => {});
  }
  try { await database.closeDatabase(); } catch (error) { logger.error('Database close failed:', error); }
  process.exit(0);
}
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── START ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await initializeConfig();
    logger.info({ database: database.databaseType }, 'Configuration loaded');
  } catch (error) {
    throw new Error(`Nie udało się uruchomić magazynu danych: ${error.message}`, { cause: error });
  }

  const sessionSecret = String(process.env.SESSION_SECRET || '');
  if (process.env.NODE_ENV === 'production' && sessionSecret.length < 32) {
    throw new Error('W produkcji SESSION_SECRET musi mieć co najmniej 32 znaki.');
  }

  const dashboardOnly = String(process.env.DASHBOARD_ONLY || '').toLowerCase() === 'true';
  const BOT_TOKEN = String(process.env.BOT_TOKEN || '').trim();
  if (!dashboardOnly && !BOT_TOKEN) throw new Error('Brak BOT_TOKEN w pliku .env!');

  dashboardHttpServer = await startDashboardServer({
    client, config, database, logger, getGuildConfig, saveConfig,
    sendVerifyPanel, sendTicketPanel, enableEmergencyMode, disableEmergencyMode,
    createServerBackup, restoreServerBackup, updateStats, calculateServerSecurityScore,
    aggregateSecurityStats, formatUptime, sendModLog, policyHtml, createReactionRolesPanelForChannel,
  });

  if (dashboardOnly) {
    logger.warn('DASHBOARD_ONLY is enabled; Discord client login was skipped.');
    return { client, dashboardHttpServer };
  }

  // Self-ping utrzymuje endpoint HTTP aktywny; nie zastępuje trwałej bazy danych.
  if (config.dashboardUrl && !String(config.dashboardUrl).includes('localhost')) {
    setInterval(async () => {
      try {
        await axios.get(`${config.dashboardUrl}/ping`, { timeout: 10_000 });
        logger.debug('Self-ping OK');
      } catch (error) {
        logger.warn('Self-ping error:', error.message);
      }
    }, 13 * 60 * 1000);
  }

  await client.login(BOT_TOKEN);
  return { client, dashboardHttpServer };
}

module.exports = { bootstrap, client };
