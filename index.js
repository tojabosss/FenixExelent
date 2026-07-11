// // ╔══════════════════════════════════════════════════════════════════╗
// ║              FenixExelent Bot — Full Edition v2.1               ║
// ║  AntiSpam · AntiRaid · ChannelGuard · Verify · Warns · Tickets ║
// ╚══════════════════════════════════════════════════════════════════╝

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
const express = require('express');
const axios   = require('axios');

let Tesseract = null;
try {
  Tesseract = require('tesseract.js');
} catch (err) {
  console.warn('⚠️ OCR AntiScam wyłączony: brakuje paczki tesseract.js. Uruchom npm install.');
}

const session = require('express-session');
const path    = require('path');
const fs = require('fs');
const app = express();

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = loadConfig();

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const def = {
      dashboardPort: parseInt(process.env.PORT) || 3000,
      dashboardUrl:  process.env.DASHBOARD_URL  || `http://localhost:${parseInt(process.env.PORT) || 3000}`,
      guilds: {},
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(def, null, 2));
    return def;
  }
  const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  // Zawsze używaj .env dla secretów
  saved.dashboardPort = parseInt(process.env.PORT) || saved.dashboardPort || 3000;
  saved.dashboardUrl  = process.env.DASHBOARD_URL  || saved.dashboardUrl  || `http://localhost:${saved.dashboardPort}`;
  return saved;
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function getGuildConfig(guildId) {
  if (!config.guilds[guildId]) config.guilds[guildId] = defaultGuildConfig();

  // Migration — upewniamy się że wszystkie pola istnieją
  const gc  = config.guilds[guildId];
  const def = defaultGuildConfig();
  for (const key of Object.keys(def)) {
    if (gc[key] === undefined || gc[key] === null) {
      gc[key] = def[key];
    } else if (typeof def[key] === 'object' && !Array.isArray(def[key])) {
      gc[key] = Object.assign({}, def[key], gc[key]);
    }
  }
  return gc;
}

function defaultGuildConfig() {
  return {
    antispam: {
      enabled: true, maxMessages: 5, interval: 3000,
      muteMinutes: 10, logChannel: null,
    },
    antiraid: {
      enabled: true, joinThreshold: 10, joinInterval: 10000,
      action: 'kick', logChannel: null, lockdownActive: false,
    },
    antiscam: {
      enabled: true,
      muteMinutes: 60,
      deleteMessage: true,
      logChannel: null,
      // Blokuje podejrzane obrazki/screeny scam.
      blockScamImages: true,
      // OCR czyta tekst ze screenów i wykrywa np. USDT, Withdrawal Success, promo code, casino.
      ocrScamImages: true,
      ocrMinScamScore: 3,
      ocrMaxImages: 2,
      ocrTimeoutMs: 25000,
      ocrMaxImageBytes: 8 * 1024 * 1024,
      // Kanały zgłoszeń scam mogą przyjmować linki/screeny bez karania zgłaszających.
      allowScamReportsInReportChannels: true,
      // Tryb ostry: blokuje same obrazki bez tekstu poza kanałami zgłoszeń scam, gdy OCR nic nie wykryje.
      blockImageOnlyScamScreenshots: false,
      whitelistedDomains: [
        'discord.com',
        'discord.gg',
        'discordapp.com',
        'youtube.com',
        'youtu.be',
        'twitch.tv',
        'github.com',
        'google.com',
        'reddit.com',
      ],
      blockedDomains: [],
      stats: { detected: 0, deleted: 0, muted: 0 },
      riskScores: {},
    },
    antialt: {
      enabled: false,
      minAccountAgeDays: 7,
      action: 'verify',
      logChannel: null,
      riskPoints: 20,
    },
    emergency: {
      active: false,
      previous: null,
    },
    securityStats: {
      scamsBlocked: 0,
      spamMuted: 0,
      raidsDetected: 0,
      altDetections: 0,
      reportsCreated: 0,
      emergencyActivations: 0,
      backupsCreated: 0,
      appealsCreated: 0,
    },
    securityIgnore: {
      channels: [],
      roles: [],
    },
    backups: {},
    appeals: {
      enabled: true,
      channelId: null,
      cases: {},
    },
    channelGuard: {
      enabled: false, blockNewChannels: false,
      whitelistedRoles: [], logChannel: null,
    },
    modLog: { channelId: null },
    warns: {},
    tickets: {
  enabled: false,
  categoryId: null,
  supportRoleId: null,
  logChannelId: null,
  openTickets: {},
},

verification: {
  enabled: false,
  roleId: null,
  unverifiedRoleId: null,
  channelId: null,
},

supportLanguages: {
  enabled: false,
  guildId: null,
  verifyChannelId: null,
  categoryId: null,
  supported: ['pl', 'en', 'tr', 'de', 'fr'],
  roleIds: {},
  channelIds: {},
},

reactionRoles: {
  enabled: false,
  channelId: null,
  messageId: null,
  roleMap: {},
},

setup: {
  statsMembersId: null,
  statsBotsId: null,
  statsTotalId: null,
  welcomeId: null,
},

modRole: null,
adminRole: null,
  };
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
  if (gc.tickets?.supportRoleId && member.roles.cache.has(gc.tickets.supportRoleId)) return true;
  return false;
}

function requireSecurityPermission(interaction, gc) {
  if (isStaffMember(interaction.member, gc)) return null;
  return interaction.reply({ content: '❌ Brak uprawnień do tej komendy.', flags: MessageFlags.Ephemeral });
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


// ═══════════════════════════════════════════════════════════════════════════
//  SUPPORT SERVER LANGUAGE VERIFICATION
//  Bez zewnętrznych API i bez limitów: użytkownik wybiera język przyciskiem.
// ═══════════════════════════════════════════════════════════════════════════
const SUPPORT_LANGUAGE_DEFINITIONS = [
  { code: 'pl', label: 'Polski',   emoji: '🇵🇱', roleName: '🌍 Polski',   channelName: '💬│chat-pl', topic: 'Polski kanał supportu FenixExelentSecurity.' },
  { code: 'en', label: 'English',  emoji: '🇬🇧', roleName: '🌍 English',  channelName: '💬│chat-en', topic: 'English FenixExelentSecurity support channel.' },
  { code: 'tr', label: 'Türkçe',   emoji: '🇹🇷', roleName: '🌍 Türkçe',   channelName: '💬│chat-tr', topic: 'Türkçe FenixExelentSecurity destek kanalı.' },
  { code: 'de', label: 'Deutsch',  emoji: '🇩🇪', roleName: '🌍 Deutsch',  channelName: '💬│chat-de', topic: 'Deutscher FenixExelentSecurity Support-Kanal.' },
  { code: 'fr', label: 'Français', emoji: '🇫🇷', roleName: '🌍 Français', channelName: '💬│chat-fr', topic: 'Canal de support français FenixExelentSecurity.' },
];

function getSupportGuildIdFromEnv() {
  return String(process.env.SUPPORT_GUILD_ID || '').trim();
}

function isConfiguredSupportGuild(guild) {
  if (!guild?.id) return false;

  const supportGuildId = getSupportGuildIdFromEnv();
  const gamingGuildId = String(process.env.GAMING_SETUP_GUILD_ID || '').trim();
  const gc = getGuildConfig(guild.id);

  // Panel języka może działać zarówno na oficjalnym support serwerze,
  // jak i na prywatnym serwerze gaming/streaming.
  if (supportGuildId && guild.id === supportGuildId) return true;
  if (gamingGuildId && guild.id === gamingGuildId) return true;

  // Fallback: działa na każdym serwerze, na którym setup zapisał aktywną konfigurację.
  return !!(gc?.supportLanguages?.enabled && gc.supportLanguages.guildId === guild.id);
}

function ensureSupportLanguagesConfig(gc) {
  if (!gc.supportLanguages) {
    gc.supportLanguages = {
      enabled: false,
      guildId: null,
      verifyChannelId: null,
      categoryId: null,
      supported: ['pl', 'en', 'tr', 'de', 'fr'],
      roleIds: {},
      channelIds: {},
    };
  }
  if (!Array.isArray(gc.supportLanguages.supported)) gc.supportLanguages.supported = ['pl', 'en', 'tr', 'de', 'fr'];
  if (!gc.supportLanguages.roleIds) gc.supportLanguages.roleIds = {};
  if (!gc.supportLanguages.channelIds) gc.supportLanguages.channelIds = {};
  return gc.supportLanguages;
}

function getSupportLanguageDefinitions(gc) {
  const cfg = ensureSupportLanguagesConfig(gc);
  const allowed = new Set(cfg.supported || []);
  return SUPPORT_LANGUAGE_DEFINITIONS.filter(lang => allowed.has(lang.code));
}

async function getOrCreateRoleByName(guild, name, color, reason) {
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === String(name).toLowerCase());
  if (!role) {
    role = await guild.roles.create({ name, colors: color ? { primaryColor: color } : undefined, reason }).catch(() => null);
  }
  return role;
}

async function getOrCreateTextChannelByName(guild, category, name, options = {}) {
  let channel = guild.channels.cache.find(ch => ch.type === ChannelType.GuildText && ch.name === name);
  if (!channel) {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: category?.id || null,
      topic: options.topic || undefined,
      permissionOverwrites: options.permissionOverwrites || undefined,
      reason: options.reason || 'FenixExelent support language setup',
    }).catch(() => null);
  } else {
    if (category && channel.parentId !== category.id) await channel.setParent(category.id).catch(() => {});
    if (options.topic && channel.topic !== options.topic) await channel.setTopic(options.topic).catch(() => {});
  }
  return channel;
}

function buildSupportLanguageRows(gc) {
  const defs = getSupportLanguageDefinitions(gc);
  const rows = [];
  for (let i = 0; i < defs.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(
      defs.slice(i, i + 5).map(lang => new ButtonBuilder()
        .setCustomId(`supportlang:${lang.code}`)
        .setLabel(`${lang.emoji} ${lang.label}`)
        .setStyle(ButtonStyle.Primary)
      )
    ));
  }
  return rows;
}

async function sendSupportLanguagePanel(channel, gc = null) {
  // Zachowujemy stary panel weryfikacji i dokładamy do niego wybór języka.
  return sendVerifyPanel(channel);
}

async function setupSupportLanguageSystem(guild, gc) {
  const supportGuildId = getSupportGuildIdFromEnv();
  const gamingGuildId = String(process.env.GAMING_SETUP_GUILD_ID || '1462330169669980244').trim();
  const allowedGuildIds = [supportGuildId, gamingGuildId].filter(Boolean);
  if (!allowedGuildIds.length) {
    return { ok: false, error: 'Brak SUPPORT_GUILD_ID lub GAMING_SETUP_GUILD_ID w Render Environment.' };
  }
  if (!allowedGuildIds.includes(guild.id)) {
    return { ok: false, error: 'Ta konfiguracja działa tylko na Twoim support lub gaming serwerze.' };
  }

  const cfg = ensureSupportLanguagesConfig(gc);
  cfg.enabled = true;
  cfg.guildId = guild.id;

  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});

  let verifiedRole = gc.verification?.roleId ? guild.roles.cache.get(gc.verification.roleId) : null;
  if (!verifiedRole) verifiedRole = await getOrCreateRoleByName(guild, 'Zweryfikowany', '#22c55e', 'FenixExelent support language setup');

  let unverifiedRole = gc.verification?.unverifiedRoleId ? guild.roles.cache.get(gc.verification.unverifiedRoleId) : null;
  if (!unverifiedRole) unverifiedRole = await getOrCreateRoleByName(guild, 'Niezweryfikowany', '#747d8c', 'FenixExelent support language setup');

  if (!gc.verification) gc.verification = { enabled: false, roleId: null, unverifiedRoleId: null, channelId: null };
  if (verifiedRole) gc.verification.roleId = verifiedRole.id;
  if (unverifiedRole) gc.verification.unverifiedRoleId = unverifiedRole.id;
  gc.verification.enabled = true;

  const verifyCategory = await getOrCreateCategory(guild, '🔐 WERYFIKACJA').catch(() => null);
  const verifyChannel = await getOrCreateTextChannelByName(guild, verifyCategory, '✅│weryfikacja', {
    topic: 'Wybierz język, aby uzyskać dostęp do supportu FenixExelentSecurity.',
    reason: 'FenixExelent support language verification channel',
    permissionOverwrites: [
      { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      ...(unverifiedRole ? [{ id: unverifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] : []),
      ...(verifiedRole ? [{ id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] : []),
    ],
  });

  if (verifyChannel) {
    gc.verification.channelId = verifyChannel.id;
    cfg.verifyChannelId = verifyChannel.id;
  }

  const category = await getOrCreateCategory(guild, '🌍 SUPPORT LANGUAGES').catch(() => null);
  if (category) cfg.categoryId = category.id;

  const createdRoles = [];
  const createdChannels = [];
  for (const lang of getSupportLanguageDefinitions(gc)) {
    const role = await getOrCreateRoleByName(guild, lang.roleName, '#3b82f6', `FenixExelent support language role ${lang.code}`);
    if (!role) continue;
    cfg.roleIds[lang.code] = role.id;
    createdRoles.push(role);

    const permissionOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];
    // Nie blokujemy roli Zweryfikowany na kanałach językowych, bo użytkownik po wyborze języka ma jednocześnie rolę Zweryfikowany + rolę języka.
    // Gdyby rola Zweryfikowany miała deny ViewChannel, Discord zablokowałby dostęp mimo roli językowej.
    if (unverifiedRole) permissionOverwrites.push({ id: unverifiedRole.id, deny: [PermissionFlagsBits.ViewChannel] });

    const channel = await getOrCreateTextChannelByName(guild, category, lang.channelName, {
      topic: lang.topic,
      reason: `FenixExelent support language channel ${lang.code}`,
      permissionOverwrites,
    });
    if (channel) {
      cfg.channelIds[lang.code] = channel.id;
      createdChannels.push(channel);

      await channel.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: false,
      }).catch(() => {});

      if (unverifiedRole) {
        await channel.permissionOverwrites.edit(unverifiedRole, {
          ViewChannel: false,
        }).catch(() => {});
      }

      if (verifiedRole) {
        await channel.permissionOverwrites.delete(verifiedRole, 'FenixExelent: verified role cannot deny language channel access').catch(() => {});
      }

      await channel.permissionOverwrites.edit(role, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      }).catch(() => {});
    }
  }

  if (verifyChannel) await sendSupportLanguagePanel(verifyChannel, gc).catch(() => {});

  saveConfig();
  return { ok: true, verifiedRole, unverifiedRole, verifyChannel, category, createdRoles, createdChannels };
}

async function handleSupportLanguageButton(interaction, gc) {
  const cfg = ensureSupportLanguagesConfig(gc);
  if (!cfg.enabled) {
    return interaction.reply({ content: '❌ Wybór języka jest aktualnie wyłączony.', flags: MessageFlags.Ephemeral });
  }
  if (!isConfiguredSupportGuild(interaction.guild)) {
    return interaction.reply({ content: '❌ Ten panel działa tylko na oficjalnym support serwerze.', flags: MessageFlags.Ephemeral });
  }

  const langCode = interaction.customId.split(':')[1];
  const lang = SUPPORT_LANGUAGE_DEFINITIONS.find(item => item.code === langCode);
  if (!lang || !cfg.roleIds?.[langCode]) {
    return interaction.reply({ content: '❌ Ten język nie jest skonfigurowany. Użyj `/supportlang setup`.', flags: MessageFlags.Ephemeral });
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return interaction.reply({ content: '❌ Nie mogę pobrać Twojego profilu.', flags: MessageFlags.Ephemeral });

  const allLangRoleIds = Object.values(cfg.roleIds || {}).filter(Boolean);
  const rolesToRemove = allLangRoleIds.filter(roleId => roleId !== cfg.roleIds[langCode] && member.roles.cache.has(roleId));
  if (rolesToRemove.length) await member.roles.remove(rolesToRemove, 'FenixExelent: zmiana języka supportu').catch(() => {});

  await member.roles.add(cfg.roleIds[langCode], `FenixExelent: wybrano język ${lang.code}`).catch(() => {});

  if (gc.verification?.roleId) await member.roles.add(gc.verification.roleId, 'FenixExelent: zweryfikowany przez wybór języka').catch(() => {});
  if (gc.verification?.unverifiedRoleId) await member.roles.remove(gc.verification.unverifiedRoleId, 'FenixExelent: zakończono weryfikację językową').catch(() => {});

  const channelId = cfg.channelIds?.[langCode];
  return interaction.reply({
    embeds: [embed(
      '#2ed573',
      `${lang.emoji} Język ustawiony / Language selected`,
      `Wybrano: **${lang.label}**
${channelId ? `Twój kanał: <#${channelId}>` : 'Kanał językowy zostanie odblokowany, jeśli jest skonfigurowany.'}`
    )],
    flags: MessageFlags.Ephemeral,
  });
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

  if (gc.verification?.unverifiedRoleId) {
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

  return { backup, rolesCreated, channelsCreated, failed };
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


// ─── PRIVATE GAMING / STREAMING SERVER TEMPLATE ─────────────────────────────
const PRIVATE_GAMING_SETUP_GUILD_ID = process.env.GAMING_SETUP_GUILD_ID || '1462330169669980244';

function getPrivateGamingSetupOwnerIds(guild) {
  const raw = process.env.GAMING_SETUP_OWNER_ID || process.env.OWNER_ID || guild?.ownerId || '';
  return String(raw)
    .split(/[\s,;]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function canUsePrivateGamingSetup(interaction) {
  if (!interaction.guild) return { ok: false, error: 'Tej komendy można używać tylko na serwerze.' };
  if (interaction.guild.id !== PRIVATE_GAMING_SETUP_GUILD_ID) {
    return { ok: false, error: `Ta komenda jest prywatna i działa tylko na serwerze ID ${PRIVATE_GAMING_SETUP_GUILD_ID}.` };
  }

  const ownerIds = getPrivateGamingSetupOwnerIds(interaction.guild);
  if (!ownerIds.includes(interaction.user.id) && interaction.user.id !== interaction.guild.ownerId) {
    return { ok: false, error: 'Ta komenda jest prywatna — może jej używać tylko właściciel ustawiony w GAMING_SETUP_OWNER_ID / OWNER_ID albo właściciel serwera.' };
  }

  if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return { ok: false, error: 'Potrzebujesz uprawnienia Administrator, żeby wykonać pełny reset serwera.' };
  }

  return { ok: true };
}

async function createPrivateRole(guild, name, color, options = {}) {
  await guild.roles.fetch().catch(() => {});
  let role = guild.roles.cache.find(r => r.name.toLowerCase() === String(name).toLowerCase());
  if (!role) {
    role = await guild.roles.create({
      name,
      colors: (color || undefined) ? { primaryColor: (color || undefined) } : undefined,
      hoist: !!options.hoist,
      mentionable: !!options.mentionable,
      permissions: options.permissions || undefined,
      reason: 'FenixExelent private gaming/streaming setup',
    }).catch(() => null);
  }
  return role;
}

async function createPrivateCategory(guild, name, permissionOverwrites = []) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
    reason: 'FenixExelent private gaming/streaming setup',
  });
}

async function createPrivateText(guild, parent, name, topic = '', permissionOverwrites = []) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent?.id || null,
    topic: topic || undefined,
    permissionOverwrites,
    reason: 'FenixExelent private gaming/streaming setup',
  });
}

async function createPrivateVoice(guild, parent, name, userLimit = 0, permissionOverwrites = []) {
  return guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: parent?.id || null,
    userLimit,
    permissionOverwrites,
    reason: 'FenixExelent private gaming/streaming setup',
  });
}

async function deleteAllGuildChannelsForTemplate(guild) {
  await guild.channels.fetch().catch(() => {});
  const channels = [...guild.channels.cache.values()]
    .sort((a, b) => {
      if (a.type === ChannelType.GuildCategory && b.type !== ChannelType.GuildCategory) return 1;
      if (a.type !== ChannelType.GuildCategory && b.type === ChannelType.GuildCategory) return -1;
      return (b.position || 0) - (a.position || 0);
    });

  let deleted = 0;
  let failed = 0;
  for (const ch of channels) {
    await ch.delete('FenixExelent private gaming/streaming reset').then(() => deleted++).catch(() => failed++);
  }
  return { deleted, failed };
}

function privateDenyEveryone(guild) {
  return [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
}

function privateAllowRole(role, extra = []) {
  return { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, ...extra] };
}

async function applyFullSecurityDefaultsAfterTemplate(guild, gc, refs) {
  ensureSecurityStats(gc);
  ensureSecurityIgnore(gc);

  const verifiedRole = refs.verifiedRole;
  const unverifiedRole = refs.unverifiedRole;
  const mutedRole = refs.mutedRole;
  const modRole = refs.modRole;
  const adminRole = refs.adminRole;
  const modLog = refs.modLogChannel;
  const securityLog = refs.securityLogChannel;
  const ticketLog = refs.ticketLogChannel;
  const scamReport = refs.scamReportChannel;
  const appealChannel = refs.appealChannel;
  const verifyChannel = refs.verifyChannel;
  const ticketChannel = refs.ticketChannel;

  gc.modRole = modRole?.id || gc.modRole || null;
  gc.adminRole = adminRole?.id || gc.adminRole || null;

  if (!gc.modLog) gc.modLog = { channelId: null };
  gc.modLog.channelId = modLog?.id || securityLog?.id || gc.modLog.channelId || null;

  gc.antispam = Object.assign({}, gc.antispam || {}, {
    enabled: true,
    maxMessages: 5,
    interval: 3000,
    muteMinutes: 10,
    logChannel: securityLog?.id || modLog?.id || null,
  });

  gc.antiraid = Object.assign({}, gc.antiraid || {}, {
    enabled: true,
    joinThreshold: 5,
    joinInterval: 10000,
    action: 'kick',
    logChannel: securityLog?.id || modLog?.id || null,
    lockdownActive: false,
  });

  gc.antiscam = Object.assign({}, gc.antiscam || {}, {
    enabled: true,
    muteMinutes: 60,
    deleteMessage: true,
    logChannel: securityLog?.id || modLog?.id || null,
    blockScamImages: true,
    ocrScamImages: true,
    ocrMinScamScore: 3,
    ocrMaxImages: 2,
    ocrTimeoutMs: 25000,
    ocrMaxImageBytes: 8 * 1024 * 1024,
    allowScamReportsInReportChannels: true,
    blockImageOnlyScamScreenshots: false,
    whitelistedDomains: gc.antiscam?.whitelistedDomains || ['discord.com', 'discord.gg', 'youtube.com', 'youtu.be', 'twitch.tv', 'kick.com', 'tiktok.com'],
    blockedDomains: normalizeBlockedDomains([...(gc.antiscam?.blockedDomains || []), ...DEFAULT_BLOCKED_DOMAINS]),
    stats: gc.antiscam?.stats || { detected: 0, deleted: 0, muted: 0 },
    riskScores: gc.antiscam?.riskScores || {},
  });

  gc.antialt = Object.assign({}, gc.antialt || {}, {
    enabled: true,
    minAccountAgeDays: 7,
    action: 'verify',
    logChannel: securityLog?.id || modLog?.id || null,
    riskPoints: 20,
  });

  gc.verification = Object.assign({}, gc.verification || {}, {
    enabled: true,
    roleId: verifiedRole?.id || null,
    unverifiedRoleId: unverifiedRole?.id || null,
    channelId: verifyChannel?.id || null,
  });

  gc.tickets = Object.assign({}, gc.tickets || {}, {
    enabled: true,
    categoryId: refs.supportCategory?.id || null,
    supportRoleId: modRole?.id || adminRole?.id || null,
    logChannelId: ticketLog?.id || modLog?.id || null,
    openTickets: gc.tickets?.openTickets || {},
  });

  gc.appeals = Object.assign({}, gc.appeals || {}, {
    enabled: true,
    channelId: appealChannel?.id || null,
    cases: gc.appeals?.cases || {},
  });

  gc.channelGuard = Object.assign({}, gc.channelGuard || {}, {
    enabled: true,
    blockNewChannels: false,
    whitelistedRoles: [adminRole?.id, modRole?.id].filter(Boolean),
    logChannel: securityLog?.id || modLog?.id || null,
  });

  // Support language verification bez zewnętrznego API tłumaczeń.
  const cfg = ensureSupportLanguagesConfig(gc);
  cfg.enabled = true;
  cfg.guildId = guild.id;
  cfg.verifyChannelId = verifyChannel?.id || null;
  cfg.categoryId = refs.chatCategory?.id || null;
  cfg.supported = ['pl', 'en', 'tr', 'de', 'fr'];
  cfg.roleIds = refs.languageRoleIds || {};
  cfg.channelIds = refs.languageChannelIds || {};

  // Kanały, na których automatyczna ochrona nie powinna przeszkadzać w obsłudze zgłoszeń.
  gc.securityIgnore.channels = [...new Set([
    ...(gc.securityIgnore.channels || []),
    ticketChannel?.id,
    ticketLog?.id,
    modLog?.id,
    securityLog?.id,
    appealChannel?.id,
    scamReport?.id,
  ].filter(Boolean))];

  if (mutedRole) {
    await guild.channels.fetch().catch(() => {});
    for (const [, ch] of guild.channels.cache) {
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildCategory) {
        await ch.permissionOverwrites.edit(mutedRole, {
          SendMessages: false,
          AddReactions: false,
          Speak: false,
        }).catch(() => {});
      }
    }
  }

  saveConfig();
}

async function setupPrivateGamingStreamingServer(guild, gc, options = {}) {
  const result = {
    backupId: null,
    deleted: 0,
    failedDelete: 0,
    roles: 0,
    channels: 0,
    failed: 0,
  };

  await guild.roles.fetch().catch(() => {});
  await guild.channels.fetch().catch(() => {});

  if (options.createBackup !== false) {
    const backup = createServerBackup(guild, gc);
    result.backupId = backup?.id || null;
  }

  if (options.deleteExisting) {
    const del = await deleteAllGuildChannelsForTemplate(guild);
    result.deleted = del.deleted;
    result.failedDelete = del.failed;
    await guild.channels.fetch().catch(() => {});
  }

  const adminRole = await createPrivateRole(guild, '🛡️ Admin', '#ef4444', { hoist: true, permissions: [PermissionFlagsBits.Administrator] });
  const modRole = await createPrivateRole(guild, '🔨 Moderator', '#f97316', { hoist: true });
  const streamerRole = await createPrivateRole(guild, '🎥 Streamer', '#a855f7', { hoist: true, mentionable: true });
  const kickRole = await createPrivateRole(guild, '🟢 Kick', '#22c55e', { mentionable: true });
  const tiktokRole = await createPrivateRole(guild, '🎵 TikTok', '#ec4899', { mentionable: true });
  const vipRole = await createPrivateRole(guild, '⭐ VIP', '#facc15', { hoist: true });
  const verifiedRole = await createPrivateRole(guild, 'Zweryfikowany', '#22c55e');
  const unverifiedRole = await createPrivateRole(guild, 'Niezweryfikowany', '#64748b');
  const mutedRole = await createPrivateRole(guild, '🔇 Muted', '#6b7280');
  const langRoles = {};
  for (const lang of SUPPORT_LANGUAGE_DEFINITIONS.filter(l => ['pl', 'en', 'tr', 'de', 'fr'].includes(l.code))) {
    langRoles[lang.code] = await createPrivateRole(guild, lang.roleName, '#3b82f6');
  }
  result.roles = [adminRole, modRole, streamerRole, kickRole, tiktokRole, vipRole, verifiedRole, unverifiedRole, mutedRole, ...Object.values(langRoles)].filter(Boolean).length;

  const staffPerms = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(adminRole ? [privateAllowRole(adminRole, [PermissionFlagsBits.SendMessages])] : []),
    ...(modRole ? [privateAllowRole(modRole, [PermissionFlagsBits.SendMessages])] : []),
  ];

  const verifyPerms = [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    ...(unverifiedRole ? [{ id: unverifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] : []),
    ...(verifiedRole ? [{ id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] : []),
  ];

  const publicReadOnly = [
    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    ...(verifiedRole ? [{ id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }] : []),
  ];

  const verifiedChat = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(verifiedRole ? [privateAllowRole(verifiedRole, [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions])] : []),
    ...(unverifiedRole ? [{ id: unverifiedRole.id, deny: [PermissionFlagsBits.ViewChannel] }] : []),
  ];

  const refs = { adminRole, modRole, verifiedRole, unverifiedRole, mutedRole, languageRoleIds: {}, languageChannelIds: {} };

  const startCat = await createPrivateCategory(guild, '🚀 START');
  const infoCat = await createPrivateCategory(guild, '📢 INFORMACJE');
  const verifyCat = await createPrivateCategory(guild, '✅ WERYFIKACJA');
  const chatCat = await createPrivateCategory(guild, '💬 CHAT');
  const streamCat = await createPrivateCategory(guild, '🎥 STREAMING');
  const gamingCat = await createPrivateCategory(guild, '🎮 GAMING');
  const supportCat = await createPrivateCategory(guild, '🎫 SUPPORT');
  const voiceCat = await createPrivateCategory(guild, '🔊 VOICE');
  const staffCat = await createPrivateCategory(guild, '🔒 STAFF', staffPerms);
  refs.chatCategory = chatCat;
  refs.supportCategory = supportCat;

  const created = [];
  created.push(await createPrivateText(guild, startCat, '👋│witajka', 'Witamy na serwerze gaming/streaming.', publicReadOnly));
  created.push(await createPrivateText(guild, startCat, '📜│regulamin', 'Regulamin serwera.', publicReadOnly));
  created.push(await createPrivateText(guild, startCat, '📌│role', 'Role społeczności i powiadomień.', verifiedChat));

  created.push(await createPrivateText(guild, infoCat, '📣│ogloszenia', 'Ogłoszenia serwera.', publicReadOnly));
  created.push(await createPrivateText(guild, infoCat, '📰│info', 'Informacje o serwerze.', publicReadOnly));
  created.push(await createPrivateText(guild, infoCat, '🤖│komendy-bota', 'Komendy FenixExelentSecurity.', verifiedChat));
  created.push(await createPrivateText(guild, infoCat, '📊│status', 'Status bota i serwera.', publicReadOnly));

  refs.verifyChannel = await createPrivateText(guild, verifyCat, '✅│weryfikacja', 'Kliknij Verify i wybierz język, aby uzyskać dostęp do serwera.', verifyPerms);
  created.push(refs.verifyChannel);

  for (const lang of SUPPORT_LANGUAGE_DEFINITIONS.filter(l => ['pl', 'en', 'tr', 'de', 'fr'].includes(l.code))) {
    const role = langRoles[lang.code];
    if (!role) continue;
    refs.languageRoleIds[lang.code] = role.id;
    const perms = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions] },
      ...(unverifiedRole ? [{ id: unverifiedRole.id, deny: [PermissionFlagsBits.ViewChannel] }] : []),
    ];
    const ch = await createPrivateText(guild, chatCat, lang.channelName, lang.topic, perms);
    refs.languageChannelIds[lang.code] = ch.id;
    created.push(ch);
  }
  created.push(await createPrivateText(guild, chatCat, '💬│chat-ogolny', 'Ogólny chat dla zweryfikowanych użytkowników.', verifiedChat));
  created.push(await createPrivateText(guild, chatCat, '📸│media', 'Screeny, klipy i zdjęcia.', verifiedChat));
  created.push(await createPrivateText(guild, chatCat, '😂│memy', 'Memy i luźne rozmowy.', verifiedChat));

  created.push(await createPrivateText(guild, streamCat, '🟢│kick-live', 'Powiadomienia i rozmowy o streamach na Kick.', verifiedChat));
  created.push(await createPrivateText(guild, streamCat, '🎵│tiktok-live', 'Powiadomienia i rozmowy o TikToku.', verifiedChat));
  created.push(await createPrivateText(guild, streamCat, '▶️│youtube', 'YouTube, klipy i materiały.', verifiedChat));
  created.push(await createPrivateText(guild, streamCat, '📅│harmonogram', 'Plan streamów i eventów.', publicReadOnly));
  created.push(await createPrivateText(guild, streamCat, '💡│pomysly-na-stream', 'Pomysły na streamy i odcinki.', verifiedChat));

  created.push(await createPrivateText(guild, gamingCat, '🎮│gaming-chat', 'Rozmowy gamingowe.', verifiedChat));
  created.push(await createPrivateText(guild, gamingCat, '🔫│cs2', 'CS2 / Counter-Strike.', verifiedChat));
  created.push(await createPrivateText(guild, gamingCat, '🕹️│szukam-ekipy', 'Szukaj osób do gry.', verifiedChat));
  created.push(await createPrivateText(guild, gamingCat, '🏆│rankingi', 'Rankingi, wyniki i osiągnięcia.', verifiedChat));

  refs.ticketChannel = await createPrivateText(guild, supportCat, '🎫│ticket', 'Otwórz ticket do administracji.', verifiedChat);
  refs.scamReportChannel = await createPrivateText(guild, supportCat, '🚨│zglos-scam', 'Zgłaszanie scam linków i podejrzanych użytkowników.', verifiedChat);
  refs.appealChannel = await createPrivateText(guild, supportCat, '📝│appeal', 'Odwołania od kar.', verifiedChat);
  created.push(refs.ticketChannel, refs.scamReportChannel, refs.appealChannel);

  refs.modLogChannel = await createPrivateText(guild, staffCat, '🔧│mod-log', 'Logi moderacji.', staffPerms);
  refs.securityLogChannel = await createPrivateText(guild, staffCat, '🛡️│security-log', 'Logi AntiScam, AntiRaid, AntiSpam i AntiAlt.', staffPerms);
  refs.ticketLogChannel = await createPrivateText(guild, staffCat, '📨│ticket-log', 'Logi ticketów.', staffPerms);
  created.push(refs.modLogChannel, refs.securityLogChannel, refs.ticketLogChannel);
  created.push(await createPrivateText(guild, staffCat, '🕵️│staff-chat', 'Kanał administracji.', staffPerms));

  created.push(await createPrivateVoice(guild, voiceCat, '🎙️│Lobby', 0, verifiedChat));
  created.push(await createPrivateVoice(guild, voiceCat, '🎮│Gaming 1', 10, verifiedChat));
  created.push(await createPrivateVoice(guild, voiceCat, '🎮│Gaming 2', 10, verifiedChat));
  created.push(await createPrivateVoice(guild, voiceCat, '🔴│Stream Room', 5, verifiedChat));
  created.push(await createPrivateVoice(guild, voiceCat, '🎧│Support Voice', 5, verifiedChat));

  result.channels = created.filter(Boolean).length + [startCat, infoCat, verifyCat, chatCat, streamCat, gamingCat, supportCat, voiceCat, staffCat].filter(Boolean).length;

  await applyFullSecurityDefaultsAfterTemplate(guild, gc, refs);

  if (refs.verifyChannel) {
    await sendVerifyPanel(refs.verifyChannel).catch(() => {});
  }
  if (refs.ticketChannel) {
    await sendTicketPanel(refs.ticketChannel).catch(() => {});
  }
  if (refs.modLogChannel) {
    await refs.modLogChannel.send({ embeds: [embed(
      '#2ed573',
      '✅ Gaming/Streaming template utworzony',
      'Serwer został zresetowany i skonfigurowany pod gaming, streaming Kick/TikTok oraz zabezpieczenia FenixExelentSecurity.',
      [
        { name: 'Backup przed resetem', value: result.backupId || 'Brak', inline: true },
        { name: 'Usunięte kanały', value: `${result.deleted}`, inline: true },
        { name: 'Nowe kanały/kategorie', value: `${result.channels}`, inline: true },
        { name: 'Zabezpieczenia', value: 'AntiSpam, AntiRaid, AntiScam + OCR, AntiAlt, Verification, Tickets, Appeals, Security Logs', inline: false },
      ]
    )] }).catch(() => {});
  }

  return result;
}


// Prywatne komendy !gamingserver zostały usunięte.

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


// ─── GAMING LANGUAGE PANEL — TEXT COMMAND ─────────────────────────────────
// Nie wymaga deploy-commands.js. Działa na support/gaming serwerze.
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const command = String(message.content || '').trim().toLowerCase();
  if (!['!language setup', '!language panel', '!language status', '!language off'].includes(command)) return;

  const allowed = message.guild.ownerId === message.author.id ||
    message.member?.permissions.has(PermissionFlagsBits.Administrator) ||
    message.member?.permissions.has(PermissionFlagsBits.ManageGuild);
  if (!allowed) return message.reply('❌ Tej komendy może użyć tylko właściciel lub administrator.').catch(() => {});

  if (!isConfiguredSupportGuild(message.guild)) {
    return message.reply('❌ Ten panel działa tylko na skonfigurowanym serwerze support/gaming. Sprawdź GAMING_SETUP_GUILD_ID.').catch(() => {});
  }

  const gc = getGuildConfig(message.guild.id);
  const cfg = ensureSupportLanguagesConfig(gc);

  if (command === '!language setup') {
    const result = await setupSupportLanguageSystem(message.guild, gc);
    if (!result.ok) return message.reply(`❌ ${result.error}`).catch(() => {});
    return message.reply(`✅ Wybór języka gotowy. Panel: ${result.verifyChannel ? `<#${result.verifyChannel.id}>` : 'kanał weryfikacji'}.`).catch(() => {});
  }

  if (command === '!language panel') {
    const target = (cfg.verifyChannelId && message.guild.channels.cache.get(cfg.verifyChannelId)) || message.channel;
    await sendSupportLanguagePanel(target, gc).catch(() => null);
    return message.reply(`✅ Panel weryfikacji i wyboru języka wysłany na <#${target.id}>.`).catch(() => {});
  }

  if (command === '!language status') {
    return message.reply(
      `**Wybór języka:** ${cfg.enabled ? '✅ Włączony' : '❌ Wyłączony'}\n` +
      `**Języki:** ${(cfg.supported || []).join(', ')}\n` +
      `**Kanał:** ${cfg.verifyChannelId ? `<#${cfg.verifyChannelId}>` : 'brak'}`
    ).catch(() => {});
  }

  cfg.enabled = false;
  saveConfig();
  return message.reply('✅ Wybór języka wyłączony. Role i kanały pozostają bez zmian.').catch(() => {});
});

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
    console.warn(`ReactionRoles add error: ${err.message || err}`);
  });
});

client.on('messageReactionRemove', async (reaction, user) => {
  const data = await resolveReactionData(reaction, user);
  if (!data) return;
  await data.member.roles.remove(data.role, 'FenixExelent: usunięto reakcję').catch(err => {
    console.warn(`ReactionRoles remove error: ${err.message || err}`);
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

  console.log(`🔄 Status bota zaktualizowany: ${guildCount} serwerów`);
}

client.once('clientReady', async () => {
  console.log(`🔥 FenixExelent online jako ${client.user.tag}`);
  console.log(`📊 Serwery: ${client.guilds.cache.size}`);

  updateBotPresence();

  for (const [, guild] of client.guilds.cache) {
    await updateStats(guild).catch(() => {});
  }

  startDashboard();
});

client.on('guildCreate', async (guild) => {
  console.log(`✅ Bot dodany na serwer: ${guild.name} (${guild.id})`);
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
  console.log(`❌ Bot usunięty z serwera: ${guild.name} (${guild.id})`);
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
      if (ocr.error) console.warn(`OCR skipped/error for ${att.name || att.url}: ${ocr.error}`);
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
      console.error('AntiSpam error:', err);
    }
  }
});

// ─── WELCOME + ANTIRAID ────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const gc = getGuildConfig(member.guild.id);
  markRecentJoin(member);
  await maybeHandleAntiAlt(member).catch(err => console.error('AntiAlt error:', err));

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
    console.error('ChannelGuard error:', err);
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

  const SUPPORT_GUILD_ID = process.env.SUPPORT_GUILD_ID || '1492793536930910310';
  const OWNER_ID = process.env.OWNER_ID || '1075478964505677824';

  if (
    interaction.guild.id === SUPPORT_GUILD_ID &&
    interaction.user.id !== OWNER_ID
  ) {
    return interaction.reply({
      content: '❌ Na oficjalnym serwerze supportowym tylko właściciel bota może używać komend.',
      flags: MessageFlags.Ephemeral
    });
  }

  const gc = getGuildConfig(interaction.guild.id);
  const { commandName } = interaction;

  try {
    await handleCommand(interaction, gc, commandName);
  } catch (err) {
    console.error(`Błąd komendy ${commandName}:`, err);
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
          { name: '⚙️ Konfiguracja',   value: '`setup` `security` `servercheck` `dashboard` `stats` `refreshbot` `backup` `appeal` `supportlang`',                                 inline: false },
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

  // ── supportlang ───────────────────────────────────────────────────────
  if (commandName === 'supportlang') {
    const sub = interaction.options.getSubcommand();

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Tylko administrator może konfigurować języki supportu.', flags: MessageFlags.Ephemeral });
    }

    if (sub === 'setup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await setupSupportLanguageSystem(interaction.guild, gc);
      if (!result.ok) {
        return interaction.editReply({ embeds: [embed('#ff4757', '❌ Support Language Setup', result.error || 'Nie udało się skonfigurować języków.')] });
      }

      return interaction.editReply({
        embeds: [embed(
          '#2ed573',
          '✅ Support językowy skonfigurowany',
          'Utworzono role, kanały i panel wyboru języka. Nowe osoby wybierają język przyciskiem i automatycznie przechodzą weryfikację.',
          [
            { name: 'Kanał weryfikacji', value: result.verifyChannel ? `<#${result.verifyChannel.id}>` : 'Brak', inline: true },
            { name: 'Kategoria', value: result.category ? result.category.name : 'Brak', inline: true },
            { name: 'Języki', value: getSupportLanguageDefinitions(gc).map(l => `${l.emoji} ${l.label}`).join('\\n'), inline: false },
          ]
        )],
      });
    }

    if (sub === 'panel') {
      const cfg = ensureSupportLanguagesConfig(gc);
      const targetChannel = cfg.verifyChannelId
        ? await interaction.guild.channels.fetch(cfg.verifyChannelId).catch(() => null)
        : interaction.channel;
      if (!targetChannel) return interaction.reply({ content: '❌ Nie znaleziono kanału panelu.', flags: MessageFlags.Ephemeral });
      await sendSupportLanguagePanel(targetChannel, gc);
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Panel wysłany', `Panel wyboru języka wysłany na <#${targetChannel.id}>.`)], flags: MessageFlags.Ephemeral });
    }

    if (sub === 'status') {
      const cfg = ensureSupportLanguagesConfig(gc);
      return interaction.reply({
        embeds: [embed(
          cfg.enabled ? '#2ed573' : '#ffa502',
          '🌍 Status support language',
          cfg.enabled ? 'System wyboru języka jest włączony.' : 'System wyboru języka jest wyłączony.',
          [
            { name: 'Support guild', value: getSupportGuildIdFromEnv() || 'Nie ustawiono SUPPORT_GUILD_ID', inline: false },
            { name: 'Kanał panelu', value: cfg.verifyChannelId ? `<#${cfg.verifyChannelId}>` : 'Brak', inline: true },
            { name: 'Kanały', value: Object.entries(cfg.channelIds || {}).map(([code, id]) => `${code.toUpperCase()}: <#${id}>`).join('\\n') || 'Brak', inline: false },
          ]
        )],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (sub === 'off') {
      const cfg = ensureSupportLanguagesConfig(gc);
      cfg.enabled = false;
      saveConfig();
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Support language wyłączony', 'Role i kanały nie zostały usunięte, ale przyciski wyboru języka przestaną działać.')], flags: MessageFlags.Ephemeral });
    }
  }

  // ── dashboard ─────────────────────────────────────────────────────────

  // Komenda /gamingserver została usunięta.

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

    // Weryfikacja
    const catVerify = await getOrCreateCategory(guild, '🔐 WERYFIKACJA');
    const chVerify  = await getOrCreateText(guild, catVerify, '✅│weryfikacja', rwText);
    await chVerify.bulkDelete(10).catch(() => {});
    await sendVerifyPanel(chVerify);
    gc.verification.channelId = chVerify.id;

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

  // ── antialt ─────────────────────────────────────────────────────────
  if (commandName === 'antialt') {
    const perm = requireSecurityPermission(interaction, gc);
    if (perm) return perm;

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
    const perm = requireSecurityPermission(interaction, gc);
    if (perm) return perm;

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

    scamReports.set(reportId, {
      reportId,
      guildId: interaction.guild.id,
      reporterId: interaction.user.id,
      targetId: user?.id || null,
      link: link || null,
      domain: domain && domain.includes('.') ? domain : null,
      opis,
      channelId: interaction.channel.id,
      createdAt: Date.now(),
    });

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
    const perm = requireSecurityPermission(interaction, gc);
    if (perm) return perm;

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
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Tylko administrator może używać backupów.', flags: MessageFlags.Ephemeral });
    }
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
      const perm = requireSecurityPermission(interaction, gc);
      if (perm) return perm;
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
      const perm = requireSecurityPermission(interaction, gc);
      if (perm) return perm;
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
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Tylko administrator może użyć Emergency Mode.', flags: MessageFlags.Ephemeral });
    }

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
    const OWNER_ID = process.env.OWNER_ID || '1075478964505677824';

    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        content: '❌ Tylko właściciel bota może użyć tej komendy.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let refreshed = 0;
    let failed = 0;

    try {
      config = loadConfig();
      updateBotPresence();

      for (const [, guild] of client.guilds.cache) {
        try {
          await updateStats(guild);
          refreshed++;
        } catch (err) {
          failed++;
          console.error(`RefreshBot stats error (${guild.id}):`, err.message);
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
      console.error('RefreshBot error:', err);

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
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: '❌ Potrzebujesz uprawnienia Zarządzanie serwerem, aby zmieniać OCR AntiScam.',
        flags: MessageFlags.Ephemeral,
      });
    }

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
      const role = interaction.options.getRole('rola');
      gc.verification.roleId = role.id;

      let unverifiedRole = interaction.guild.roles.cache.find(r => r.name === 'Niezweryfikowany');

      if (!unverifiedRole) {
        unverifiedRole = await interaction.guild.roles.create({
          name: 'Niezweryfikowany',
          colors: ('#747d8c') ? { primaryColor: ('#747d8c') } : undefined,
          reason: 'FenixExelent Verification',
        });
      }

      gc.verification.unverifiedRoleId = unverifiedRole.id;

      // Ustaw uprawnienia: Niezweryfikowany widzi tylko kanał weryfikacji
      const verifyChannelId = gc.verification.channelId;
      for (const [, ch] of interaction.guild.channels.cache) {
        try {
          if (verifyChannelId && ch.id === verifyChannelId) {
            await ch.permissionOverwrites.edit(unverifiedRole, {
              ViewChannel: true,
              ReadMessageHistory: true,
              SendMessages: true,
            });
          } else if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildCategory) {
            await ch.permissionOverwrites.edit(unverifiedRole, {
              ViewChannel: false,
            });
          }
        } catch {}
      }

      saveConfig();
      return interaction.reply({
        embeds: [embed(
          '#2ed573',
          '✅ Weryfikacja skonfigurowana',
          `Rola po weryfikacji: <@&${role.id}>\nRola przed weryfikacją: <@&${unverifiedRole.id}>\nNowi użytkownicy dostaną rolę Niezweryfikowany. Po nadaniu roli Member bot ją usunie.`
        )],
        flags: MessageFlags.Ephemeral
      });
    }
    if (sub === 'on')  { gc.verification.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ Weryfikacja włączona',  'System weryfikacji jest aktywny.')],     flags: MessageFlags.Ephemeral }); }
    if (sub === 'off') { gc.verification.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ Weryfikacja wyłączona', 'System weryfikacji jest nieaktywny.')], flags: MessageFlags.Ephemeral }); }
    if (sub === 'panel') {
      await sendVerifyPanel(interaction.channel);
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Panel wysłany', `Panel weryfikacyjny wysłany na <#${interaction.channel.id}>.`)], flags: MessageFlags.Ephemeral });
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
    const SUPPORT_GUILD_ID = process.env.SUPPORT_GUILD_ID || '1492793536930910310';

    if (interaction.guild.id !== SUPPORT_GUILD_ID) {
      return interaction.reply({
        content: '❌ Ta komenda działa tylko na oficjalnym serwerze FenixExelent.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '❌ Tylko administrator może użyć tej komendy.',
        flags: MessageFlags.Ephemeral,
      });
    }

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
      console.error(`Refresh error for #${name}:`, err.message);
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
  const gc = channel.guild ? getGuildConfig(channel.guild.id) : null;
  const isSupportLanguagePanel = !!(channel.guild && isConfiguredSupportGuild(channel.guild) && gc?.supportLanguages?.enabled);

  const verifyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_btn')
      .setLabel('✅ Verify / Zweryfikuj się')
      .setStyle(ButtonStyle.Success)
  );

  const components = [verifyRow];
  let extraDescription = '';

  if (isSupportLanguagePanel) {
    const languageRows = buildSupportLanguageRows(gc);
    components.push(...languageRows);
    extraDescription = `

━━━━━━━━━━━━━━━━━━━━

🌍 **Wybór języka / Language selection**
Wybierz język poniżej, aby otrzymać odpowiednią rolę i dostęp do właściwego kanału supportu.

Choose your language below to receive the correct role and access to the right support channel.`;
  }

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
    console.error(`Błąd przycisku ${interaction.customId}:`, err);
    const errMsg = { content: '❌ Wystąpił błąd.', flags: MessageFlags.Ephemeral };
    if (!interaction.replied && !interaction.deferred) await interaction.reply(errMsg).catch(() => {});
  }
});

async function handleButton(interaction, gc) {

  if (interaction.customId.startsWith('supportlang:')) {
    return handleSupportLanguageButton(interaction, gc);
  }

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
    const report = scamReports.get(reportId);
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
  if (isConfiguredSupportGuild(interaction.guild) && gc.supportLanguages?.enabled) {
    return interaction.reply({
      content: '🌍 Ten panel ma dodatkowy wybór języka. Kliknij przycisk PL / EN / TR / DE / FR pod panelem — wybór języka jednocześnie zweryfikuje konto i odblokuje właściwy kanał supportu.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!gc.verification.enabled) {
    return interaction.reply({
      content: '❌ Weryfikacja jest aktualnie wyłączona.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (!gc.verification.roleId) {
    return interaction.reply({
      content: '❌ Rola weryfikacji nie jest skonfigurowana. Admin musi użyć `/verification setup`.',
      flags: MessageFlags.Ephemeral
    });
  }

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (member.roles.cache.has(gc.verification.roleId)) {
      return interaction.reply({
        content: '✅ Jesteś już zweryfikowany/a!',
        flags: MessageFlags.Ephemeral
      });
    }

    await member.roles.add(gc.verification.roleId);

    if (gc.verification.unverifiedRoleId) {
      await member.roles.remove(gc.verification.unverifiedRoleId).catch(() => {});
    }

    return interaction.reply({
      embeds: [embed(
        '#2ed573',
        '✅ Zweryfikowano!',
        `Witaj na **${interaction.guild.name}**! Masz teraz pełny dostęp do serwera. 🔥`
      )],
      flags: MessageFlags.Ephemeral
    });

  } catch (err) {
    console.error('Verify error:', err);

    return interaction.reply({
      content: '❌ Wystąpił błąd podczas weryfikacji.',
      flags: MessageFlags.Ephemeral
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
      console.error('Ticket open error:', err);
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
function startDashboard() {
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'dashboard', 'public')));

  app.use(session({
    secret: process.env.SESSION_SECRET || 'fenixexelent_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      secure: false,
    },
  }));

  function requireAuth(req, res, next) {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Niezalogowany' });
    }
    next();
  }

  function hasAdminOnGuild(req, guildId) {
    if (!req.session.guilds) return false;

    const OWNER_ID = process.env.OWNER_ID || '1075478964505677824';
    if (req.session.user?.id === OWNER_ID) return true;

    const guild = req.session.guilds.find(g => g.id === guildId);
    if (!guild) return false;

    return (BigInt(guild.permissions) & BigInt(0x8)) === BigInt(0x8);
  }

  const CLIENT_ID = process.env.CLIENT_ID;
  const CLIENT_SECRET = process.env.CLIENT_SECRET;
  const REDIRECT_URI = process.env.REDIRECT_URI || `${config.dashboardUrl}/callback`;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('⚠️ Brakuje CLIENT_ID albo CLIENT_SECRET w .env — logowanie Discord OAuth2 nie zadziała.');
  }

  // OAuth2
  app.get('/invite', (req, res) => {
    return res.redirect(
      `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`
    );
  });

  app.get('/login', (req, res) => {
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', 'identify guilds');

    return res.redirect(url.toString());
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/dashboard.html'));
  });

  app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/dashboard.html?error=no_code');

    try {
      const tokenRes = await axios.post(
        'https://discord.com/api/oauth2/token',
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const accessToken = tokenRes.data.access_token;

      const [userRes, guildsRes] = await Promise.all([
        axios.get('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        axios.get('https://discord.com/api/users/@me/guilds', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      ]);

      req.session.user = userRes.data;
      req.session.guilds = guildsRes.data;
      req.session.token = accessToken;

      return res.redirect('/dashboard.html');
    } catch (err) {
      console.error('OAuth2 error:', err.response?.data || err.message);
      return res.redirect('/dashboard.html?error=auth_failed');
    }
  });

  // API endpoints
  app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.json({ loggedIn: false });

    const u = req.session.user;

    return res.json({
      loggedIn: true,
      user: {
        id: u.id,
        username: u.username,
        avatar: u.avatar
          ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
          : 'https://cdn.discordapp.com/embed/avatars/0.png',
      },
    });
  });

  app.get('/api/guilds', requireAuth, (req, res) => {
    const OWNER_ID = process.env.OWNER_ID || '1075478964505677824';
    const botGuildIds = new Set(client.guilds.cache.keys());

    const visibleGuilds = req.session.guilds
      .filter(g => {
        const isOwner = req.session.user?.id === OWNER_ID;
        const isAdmin = (BigInt(g.permissions) & BigInt(0x8)) === BigInt(0x8);
        return (isOwner || isAdmin) && botGuildIds.has(g.id);
      })
      .map(g => ({
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
        hasBot: botGuildIds.has(g.id),
        memberCount: client.guilds.cache.get(g.id)?.memberCount || null,
      }));

    return res.json(visibleGuilds);
  });

  app.get('/api/guild/:guildId/meta', requireAuth, async (req, res) => {
    const { guildId } = req.params;
    if (!hasAdminOnGuild(req, guildId)) {
      return res.status(403).json({ error: 'Brak uprawnień' });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(404).json({ error: 'Bot nie jest na tym serwerze' });
    }

    await guild.channels.fetch().catch(() => {});
    await guild.roles.fetch().catch(() => {});

    const channels = guild.channels.cache
      .filter(ch => ch.type === ChannelType.GuildText)
      .map(ch => ({ id: ch.id, name: ch.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const roles = guild.roles.cache
      .filter(r => !r.managed && r.id !== guild.roles.everyone.id)
      .map(r => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ channels, roles });
  });

  app.get('/api/config/:guildId', requireAuth, (req, res) => {
    const { guildId } = req.params;

    if (!hasAdminOnGuild(req, guildId)) {
      return res.status(403).json({ error: 'Brak uprawnień' });
    }

    return res.json(getGuildConfig(guildId));
  });

  app.post('/api/config/:guildId', requireAuth, async (req, res) => {
    const { guildId } = req.params;

    if (!hasAdminOnGuild(req, guildId)) {
      return res.status(403).json({ error: 'Brak uprawnień' });
    }

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(404).json({ error: 'Bot nie jest na tym serwerze' });
    }

    const gc = getGuildConfig(guildId);
    const allowed = [
      'antispam',
      'antiraid',
      'antiscam',
      'channelGuard',
      'verification',
      'tickets',
      'modLog',
      'antialt',
      'emergency',
      'securityIgnore',
      'appeals',
      'supportLanguages',
    ];

    for (const key of allowed) {
      if (req.body[key]) Object.assign(gc[key], req.body[key]);
    }

    const actions = req.body.actions || {};

    if (req.body.antiraid?.lockdownActive !== undefined) {
      for (const [, ch] of guild.channels.cache) {
        if (ch.type === ChannelType.GuildText) {
          await ch.permissionOverwrites.edit(guild.roles.everyone, {
            SendMessages: req.body.antiraid.lockdownActive ? false : null,
          }).catch(() => {});
        }
      }
    }

    if (actions.sendVerificationPanel) {
      const channelId = gc.verification.channelId;
      const ch = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
      if (ch) await sendVerifyPanel(ch).catch(console.error);
    }

    if (actions.sendTicketPanel) {
      const channelId = gc.tickets.panelChannelId || gc.tickets.logChannelId;
      const ch = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
      if (ch) await sendTicketPanel(ch).catch(console.error);
    }

    saveConfig();

    const logChannelId =
      gc.modLog?.channelId ||
      gc.antiraid?.logChannel ||
      gc.antispam?.logChannel ||
      gc.antiscam?.logChannel ||
      gc.channelGuard?.logChannel;

    if (logChannelId) {
      const logCh = await guild.channels.fetch(logChannelId).catch(() => null);
      if (logCh) {
        await logCh.send({
          embeds: [embed(
            '#2ed573',
            '⚙️ Dashboard zaktualizowany',
            'Ustawienia serwera zostały zmienione przez panel WWW.',
            [
              { name: 'AntiSpam', value: gc.antispam.enabled ? '✅ Włączony' : '❌ Wyłączony', inline: true },
              { name: 'AntiRaid', value: gc.antiraid.enabled ? '✅ Włączony' : '❌ Wyłączony', inline: true },
              { name: 'Channel Guard', value: gc.channelGuard.blockNewChannels ? '✅ Aktywny' : '❌ Wyłączony', inline: true },
            ]
          )],
        }).catch(() => {});
      }
    }

    return res.json({ success: true, config: gc });
  });

  app.post('/api/mod/:guildId/warn', requireAuth, async (req, res) => {
    const { guildId } = req.params;
    if (!hasAdminOnGuild(req, guildId)) {
      return res.status(403).json({ error: 'Brak uprawnień' });
    }

    const { userId, reason } = req.body;
    if (!userId || !reason) {
      return res.status(400).json({ error: 'Brak danych' });
    }

    const gc = getGuildConfig(guildId);
    if (!gc.warns[userId]) gc.warns[userId] = [];
    gc.warns[userId].push({
      reason,
      mod: req.session.user.username,
      date: new Date().toISOString(),
    });

    saveConfig();
    return res.json({ success: true, count: gc.warns[userId].length });
  });

  app.get('/api/mod/:guildId/warns/:userId', requireAuth, (req, res) => {
    const { guildId, userId } = req.params;

    if (!hasAdminOnGuild(req, guildId)) {
      return res.status(403).json({ error: 'Brak uprawnień' });
    }

    const gc = getGuildConfig(guildId);
    return res.json(gc.warns[userId] || []);
  });


  app.get('/privacy', (req, res) => res.type('html').send(policyHtml('privacy')));
  app.get('/terms', (req, res) => res.type('html').send(policyHtml('terms')));
  app.get('/about', (req, res) => res.type('html').send(policyHtml('about')));
  app.get('/support', (req, res) => res.type('html').send(policyHtml('support')));

  app.get('/api/public-status', async (req, res) => {
    let users = 0;
    let bots = 0;

    for (const [, guild] of client.guilds.cache) {
      await guild.members.fetch().catch(() => {});
      users += guild.members.cache.filter(member => !member.user.bot).size;
      bots += guild.members.cache.filter(member => member.user.bot).size;
    }

    return res.json({
      name: client.user?.username || 'FenixExelentSecurity',
      guilds: client.guilds.cache.size,
      users,
      bots,
      total: users + bots,
      uptime: Math.floor(process.uptime()),
      uptimeText: formatUptime(process.uptime()),
      ping: client.ws.ping,
      security: aggregateSecurityStats(),
    });
  });

  app.get('/public-status', async (req, res) => {
    const stats = aggregateSecurityStats();
    return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FenixExelentSecurity Public Status</title>
<style>
body{margin:0;font-family:Arial,sans-serif;background:#050712;color:#f8fbff}main{max-width:1000px;margin:0 auto;padding:36px}.hero{border:1px solid rgba(96,165,250,.25);border-radius:24px;padding:28px;background:linear-gradient(135deg,rgba(37,99,235,.18),rgba(245,158,11,.12))}h1{margin:0 0 8px;font-size:36px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-top:22px}.card{border:1px solid rgba(96,165,250,.22);border-radius:18px;padding:20px;background:#0d1428}.card b{font-size:30px;color:#f59e0b}.muted{color:#9fb0d0}.ok{color:#22c55e;font-weight:900}</style>
</head>
<body><main>
<div class="hero"><h1>🔥 FenixExelentSecurity</h1><p class="muted">Public bot status and security impact.</p><p class="ok">● Online</p></div>
<div class="grid">
<div class="card"><b>${client.guilds.cache.size}</b><p>Servers</p></div>
<div class="card"><b>${client.ws.ping}ms</b><p>Ping</p></div>
<div class="card"><b>${formatUptime(process.uptime())}</b><p>Uptime</p></div>
<div class="card"><b>${stats.scamsBlocked}</b><p>Scams blocked</p></div>
<div class="card"><b>${stats.spamMuted}</b><p>Spam mutes</p></div>
<div class="card"><b>${stats.raidsDetected}</b><p>Raids detected</p></div>
<div class="card"><b>${stats.altDetections}</b><p>New account alerts</p></div>
<div class="card"><b>${stats.reportsCreated}</b><p>Scam reports</p></div>
</div>
<p class="muted">Invite: <a style="color:#60a5fa" href="/invite">Add FenixExelentSecurity</a></p>
</main></body></html>`);
  });

  app.get('/api/stats', async (req, res) => {
  let users = 0;
  let bots = 0;

  for (const [, guild] of client.guilds.cache) {
    await guild.members.fetch().catch(() => {});

    users += guild.members.cache.filter(member => !member.user.bot).size;
    bots += guild.members.cache.filter(member => member.user.bot).size;
  }

  return res.json({
    guilds: client.guilds.cache.size,
    users,
    bots,
    total: users + bots,
    uptime: Math.floor(process.uptime()),
    ping: client.ws.ping,
    security: aggregateSecurityStats(),
  });
});

  app.get('/ping', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

  app.listen(config.dashboardPort, () => {
    console.log(`\n+------------------------------------------------------+`);
    console.log(`  Dashboard: ${config.dashboardUrl}`);
    console.log(`  Login:     ${config.dashboardUrl + '/login'}`);
    console.log(`  Invite:    ${config.dashboardUrl + '/invite'}`);
    console.log(`+------------------------------------------------------+\n`);
  });
}

// ─── START ─────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Brak BOT_TOKEN w pliku .env!');
  process.exit(1);
}
// ─── SELF-PING (zapobiega zasypianiu na Render) ────────────────────────────
setInterval(async () => {
  try {
    await axios.get(`${config.dashboardUrl}/ping`);
    console.log('Self-ping OK');
  } catch (err) {
    console.error('Self-ping error:', err.message);
  }
}, 13 * 60 * 1000); // co 13 minut
client.login(BOT_TOKEN).catch(err => {
  console.error('Blad logowania:', err.message);
  process.exit(1);
});