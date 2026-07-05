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
} = require('discord.js');

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── STATE ─────────────────────────────────────────────────────────────────
const spamMap    = new Map(); // userId -> timestamp[]
const mutedUsers = new Set(); // userId
const joinMap    = new Map(); // guildId -> timestamp[]

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

client.once('ready', async () => {
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
});

client.on('guildDelete', async (guild) => {
  console.log(`❌ Bot usunięty z serwera: ${guild.name} (${guild.id})`);
  updateBotPresence();
});

setInterval(() => {
  updateBotPresence();
}, 5 * 60 * 1000);

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

const TRUSTED_DOMAINS = [
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
  'twitter.com',
  'tiktok.com',
  'instagram.com',
  'facebook.com',
  'steamcommunity.com',
  'steampowered.com',
  'crypto.com',
  'coinbase.com',
  'binance.com'
];

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

  // Crypto / casino / fake reward scam — przykłady jak ze screenów
  'buzzium.com',
  'tornavlin.com',
  'fomavlin.com',
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
  'usdt-bonus.xyz',
  'claim-usdt.xyz',
  'free-usdt.xyz',
  'beast-bonus.xyz',
  'mrbeast-giveaway.xyz',
  'casino-bonus.xyz',
  'wallet-reward.xyz',

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
  'shop',
  'store',
  'icu',
  'cyou',
  'club',
  'pro',
  'live',
  'fun',
  'lol',
  'link',
  'cloud',
  'quest',
  'monster',
  'sbs',
  'world'
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
  'bitcoin',
  'btc',
  'eth',
  'usdt',
  'wallet',
  'withdraw',
  'deposit',
  'casino',
  'bet',
  'beast',
  'giveaway',
  'promo',
  'prize',
  'money',
  'cash'
];

const CRYPTO_CASINO_SCAM_PATTERNS = [
  /withdrawal\s+success/i,
  /\bwithdraw(?:al|n)?\b.*\b(?:usdt|btc|eth|crypto|wallet|bonus|reward)\b/i,
  /\b(?:usdt|btc|eth|crypto|wallet)\b.*\b(?:withdraw|bonus|reward|claim|airdrop|giveaway)\b/i,
  /\bpromo\s*code\b/i,
  /\bbonus\s*(?:code|reward|usdt|btc|eth)\b/i,
  /\bclaim\s+(?:your\s+)?(?:reward|bonus|airdrop|nitro|usdt|crypto|prize)\b/i,
  /\b(?:casino|betting?|gambl(?:e|ing))\b.*\b(?:bonus|promo|code|usdt|crypto|reward|withdraw)\b/i,
  /\b(?:mr\s*beast|beast\s*games?)\b.*\b(?:casino|crypto|bonus|usdt|withdraw|reward|promo)\b/i,
  /\$\s*\d{2,7}\s*(?:usdt|usd|btc|eth)\b/i,
  /\b\d{2,7}\s*(?:usdt|btc|eth)\b/i,
];

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

function domainMatches(domain, rule) {
  const clean = normalizeDomainInput(domain);
  const target = normalizeDomainInput(rule);
  return clean === target || clean.endsWith(`.${target}`);
}

function isTrustedDomain(domain) {
  const clean = normalizeDomainInput(domain);
  return TRUSTED_DOMAINS.some(trusted => domainMatches(clean, trusted));
}

function isBlockedDomain(domain, blockedDomains = DEFAULT_BLOCKED_DOMAINS) {
  const clean = normalizeDomainInput(domain);
  return blockedDomains.some(blocked => domainMatches(clean, blocked));
}

function hasCryptoCasinoScamText(text) {
  const content = String(text || '');
  return CRYPTO_CASINO_SCAM_PATTERNS.some(pattern => pattern.test(content));
}

function isSuspiciousDomain(domain, text = '') {
  const clean = normalizeDomainInput(domain);
  if (!clean || isTrustedDomain(clean)) return false;

  const parts = clean.split('.');
  const tld = parts.pop();
  const name = parts.join('.');
  const hits = SUSPICIOUS_KEYWORDS.filter(word => name.includes(word));

  if (SUSPICIOUS_TLDS.includes(tld) && hits.length >= 1) return true;
  if (hits.length >= 2) return true;
  if (hasCryptoCasinoScamText(text) && hits.length >= 1) return true;

  return false;
}

function scanMessageForScam(content, gc) {
  const text = String(content || '');
  const domains = extractDomains(text);

  // Ważne: łączymy wbudowaną bazę z domenami dodanymi komendą /scamdomains.
  // Wcześniej pusta tablica w configu mogła wyłączać domyślną bazę domen.
  const blocked = normalizeBlockedDomains([
    ...DEFAULT_BLOCKED_DOMAINS,
    ...(gc.antiscam?.blockedDomains || []),
  ]);

  if (gc.antiscam) gc.antiscam.blockedDomains = blocked;

  const foundDomain = domains.find(domain =>
    !isTrustedDomain(domain) &&
    (isBlockedDomain(domain, blocked) || isSuspiciousDomain(domain, text))
  );

  if (foundDomain) {
    return {
      type: 'domain',
      value: foundDomain,
      reason: isBlockedDomain(foundDomain, blocked)
        ? 'Domena jest na liście blokowanych domen.'
        : 'Podejrzana domena pasuje do wzorca scam/crypto/casino.'
    };
  }

  // Blokuj też wiadomości z dowolną obcą domeną, jeżeli tekst wygląda jak scam
  // typu „Withdrawal Success”, „$5000 USDT”, „promo code”, „casino bonus”.
  if (domains.length && hasCryptoCasinoScamText(text)) {
    const nonTrusted = domains.find(domain => !isTrustedDomain(domain));
    if (nonTrusted) {
      return {
        type: 'text+domain',
        value: nonTrusted,
        reason: 'Wiadomość z linkiem zawiera tekst typowy dla crypto/casino scam.'
      };
    }
  }

  return null;
}

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const gc = getGuildConfig(message.guild.id);
  if (!gc.antiscam?.enabled) return;

  const scam = scanMessageForScam(message.content, gc);
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
      `<@${message.author.id}>, Twoja wiadomość wygląda jak scam link i została zablokowana.`,
      [
        { name: 'Wykryto', value: `\`${found}\``, inline: true },
        { name: 'Powód', value: scam.reason, inline: false },
        { name: 'Mute', value: `${gc.antiscam.muteMinutes || 60} min`, inline: true }
      ]
    )]
  }).then(msg => {
    setTimeout(() => msg.delete().catch(() => {}), 8000);
  }).catch(() => {});

  await sendLog(message.guild, gc.antiscam.logChannel, embed(
    '#ff4757',
    '🔍 AntiScam — zablokowany scam link',
    `Wykryto scam link od ${message.author.tag}.`,
    [
      { name: 'Użytkownik', value: `<@${message.author.id}>`, inline: true },
      { name: 'Wykryto', value: `\`${found}\``, inline: true },
      { name: 'Powód', value: scam.reason, inline: false },
      { name: 'Kanał', value: `<#${message.channel.id}>`, inline: true },
      { name: 'Treść', value: message.content.slice(0, 500) || 'Brak treści', inline: false }
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
    return interaction.reply({ content: '❌ Tej komendy można używać tylko na serwerze.', ephemeral: true });
  }

  const SUPPORT_GUILD_ID = process.env.SUPPORT_GUILD_ID || '1492793536930910310';
  const OWNER_ID = process.env.OWNER_ID || '1075478964505677824';

  if (
    interaction.guild.id === SUPPORT_GUILD_ID &&
    interaction.user.id !== OWNER_ID
  ) {
    return interaction.reply({
      content: '❌ Na oficjalnym serwerze supportowym tylko właściciel bota może używać komend.',
      ephemeral: true
    });
  }

  const gc = getGuildConfig(interaction.guild.id);
  const { commandName } = interaction;

  try {
    await handleCommand(interaction, gc, commandName);
  } catch (err) {
    console.error(`Błąd komendy ${commandName}:`, err);
    const errMsg = { embeds: [embed('#ff4757', '❌ Błąd', 'Wystąpił nieoczekiwany błąd. Spróbuj ponownie.')], ephemeral: true };
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
          { name: '⚙️ Konfiguracja',   value: '`setup` `security` `status` `dashboard` `stats`',                                              inline: false },
          { name: '🚫 AntiSpam',        value: '`antispam on` `antispam off` `antispam set` `antispam log`',                                    inline: true  },
          { name: '🚨 AntiRaid',        value: '`antiraid on` `antiraid off` `antiraid set` `antiraid lockdown` `antiraid log`',                inline: true  },
          { name: '🔒 Channel Guard',   value: '`channelguard on` `channelguard off` `channelguard whitelist` `channelguard log`',              inline: true  },
          { name: '✅ Weryfikacja',     value: '`verification setup` `verification on` `verification off` `verification panel`',               inline: true  },
          { name: '🎫 Tickety',         value: '`ticket setup` `ticket on` `ticket off` `ticket panel`',                                       inline: true  },
          { name: '🔧 Moderacja',       value: '`warn` `warnings` `clearwarns` `kick` `ban` `unban` `unmute`',                                 inline: true  },
          { name: '📋 Mod Log',         value: '`modlog` — ustaw kanał logów moderacji',                                                       inline: true  },
        )
        .setFooter({ text: 'FenixExelent 🔥 | Wszystkie komendy' })
        .setTimestamp()
      ],
      ephemeral: true,
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
      ephemeral: true,
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
      ephemeral: true,
    });
  }

  // ── stats ─────────────────────────────────────────────────────────────
  if (commandName === 'stats') {
    await interaction.deferReply({ ephemeral: true });
    await updateStats(interaction.guild);
    return interaction.editReply({ embeds: [embed('#2ed573', '✅ Statystyki odświeżone', 'Kanały statystyk zostały zaktualizowane.')] });
  }

  // ── modlog ────────────────────────────────────────────────────────────
  if (commandName === 'modlog') {
    const ch = interaction.options.getChannel('kanal');
    gc.modLog.channelId = ch.id;
    saveConfig();
    return interaction.reply({ embeds: [embed('#2ed573', '✅ Mod Log ustawiony', `Logi moderacji → <#${ch.id}>`)], ephemeral: true });
  }

  // ── antispam ──────────────────────────────────────────────────────────
  if (commandName === 'antispam') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on')  { gc.antispam.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiSpam włączony',  'Ochrona aktywna.')],    ephemeral: true }); }
    if (sub === 'off') { gc.antispam.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ AntiSpam wyłączony', 'Ochrona wyłączona.')], ephemeral: true }); }
    if (sub === 'set') {
      gc.antispam.maxMessages = interaction.options.getInteger('wiadomosci');
      gc.antispam.interval    = interaction.options.getInteger('czas') * 1000;
      const mute = interaction.options.getInteger('mute');
      if (mute) gc.antispam.muteMinutes = mute;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiSpam zaktualizowany', `Limit: ${gc.antispam.maxMessages} msg / ${gc.antispam.interval / 1000}s, mute: ${gc.antispam.muteMinutes} min`)], ephemeral: true });
    }
    if (sub === 'log') {
      gc.antispam.logChannel = interaction.options.getChannel('kanal').id;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Logi ustawione', `AntiSpam → <#${gc.antispam.logChannel}>`)], ephemeral: true });
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
        ephemeral: true,
      });
    }

    if (sub === 'off') {
      gc.antiscam.enabled = false;
      saveConfig();
      return interaction.reply({
        embeds: [embed('#ff4757', '❌ AntiScam wyłączony', 'Ochrona przed scam linkami została wyłączona.')],
        ephemeral: true,
      });
    }

    if (sub === 'log') {
      const ch = interaction.options.getChannel('kanal');
      gc.antiscam.logChannel = ch.id;
      saveConfig();

      return interaction.reply({
        embeds: [embed('#2ed573', '✅ Logi AntiScam ustawione', `Kanał logów → <#${ch.id}>`)],
        ephemeral: true,
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
      ephemeral: true,
    });
  }

  if (sub === 'remove') {
    const domain = normalizeDomainInput(interaction.options.getString('domena'));

    gc.antiscam.blockedDomains = gc.antiscam.blockedDomains.filter(d => d !== domain);
    saveConfig();

    return interaction.reply({
      embeds: [embed('#ff4757', '🗑️ Domena usunięta', `\`${domain}\` usunięto z bazy scam domen.`)],
      ephemeral: true,
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
      ephemeral: true,
    });
  }
}

// ── antiraid ──────────────────────────────────────────────────────────
if (commandName === 'antiraid') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on')  { gc.antiraid.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiRaid włączony',  'Ochrona aktywna.')],    ephemeral: true }); }
    if (sub === 'off') { gc.antiraid.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ AntiRaid wyłączony', 'Ochrona wyłączona.')], ephemeral: true }); }
    if (sub === 'set') {
      gc.antiraid.joinThreshold = interaction.options.getInteger('dolaczenia');
      gc.antiraid.joinInterval  = interaction.options.getInteger('czas') * 1000;
      const akcja = interaction.options.getString('akcja');
      if (akcja) gc.antiraid.action = akcja;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ AntiRaid zaktualizowany', `Próg: ${gc.antiraid.joinThreshold} / ${gc.antiraid.joinInterval / 1000}s, akcja: ${gc.antiraid.action.toUpperCase()}`)], ephemeral: true });
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
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Logi ustawione', `AntiRaid → <#${gc.antiraid.logChannel}>`)], ephemeral: true });
    }
  }

  // ── channelguard ──────────────────────────────────────────────────────
  if (commandName === 'channelguard') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on')  { gc.channelGuard.enabled = true; gc.channelGuard.blockNewChannels = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ Channel Guard włączony', 'Blokada aktywna.')],              ephemeral: true }); }
    if (sub === 'off') { gc.channelGuard.blockNewChannels = false;                                  saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ Channel Guard wyłączony', 'Tworzenie kanałów dozwolone.')], ephemeral: true }); }
    if (sub === 'whitelist') {
      const role = interaction.options.getRole('rola');
      if (!gc.channelGuard.whitelistedRoles.includes(role.id)) {
        gc.channelGuard.whitelistedRoles.push(role.id);
        saveConfig();
      }
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Rola dodana do whitelisty', `<@&${role.id}> może tworzyć kanały.`)], ephemeral: true });
    }
    if (sub === 'log') {
      gc.channelGuard.logChannel = interaction.options.getChannel('kanal').id;
      saveConfig();
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Logi ustawione', `Channel Guard → <#${gc.channelGuard.logChannel}>`)], ephemeral: true });
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
    )], ephemeral: true });
  }

  // ── warnings ──────────────────────────────────────────────────────────
  if (commandName === 'warnings') {
    const user  = interaction.options.getUser('uzytkownik');
    const warns = gc.warns[user.id] || [];
    if (!warns.length) {
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Brak ostrzeżeń', `<@${user.id}> nie ma żadnych ostrzeżeń.`)], ephemeral: true });
    }
    const list = warns.map((w, i) =>
      `**${i + 1}.** ${w.reason} — *${w.mod}* | ${new Date(w.date).toLocaleDateString('pl-PL')}`
    ).join('\n');
    return interaction.reply({ embeds: [embed(
      '#ffa502', `⚠️ Ostrzeżenia — ${user.tag}`, list,
      [{ name: 'Łącznie', value: `${warns.length} ostrzeżeń`, inline: true }]
    )], ephemeral: true });
  }

  // ── clearwarns ────────────────────────────────────────────────────────
  if (commandName === 'clearwarns') {
    const user  = interaction.options.getUser('uzytkownik');
    const count = (gc.warns[user.id] || []).length;
    gc.warns[user.id] = [];
    saveConfig();
    await sendModLog(interaction.guild, 'CLEAR WARNS', user, interaction.user, `Usunięto ${count} ostrzeżeń`, '#2ed573');
    return interaction.reply({ embeds: [embed('#2ed573', '🗑️ Ostrzeżenia wyczyszczone', `Usunięto **${count}** ostrzeżeń dla <@${user.id}>.`)], ephemeral: true });
  }

  // ── unmute ────────────────────────────────────────────────────────────
  if (commandName === 'unmute') {
    const user = interaction.options.getUser('uzytkownik');
    try {
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(null);
      mutedUsers.delete(user.id);
      await sendModLog(interaction.guild, 'UNMUTE', user, interaction.user, 'Ręczne zdjęcie muta', '#2ed573');
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Muta zdjęty', `Zdjęto muta z <@${user.id}>.`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie udało się zdjąć muta.')], ephemeral: true });
    }
  }

  // ── kick ──────────────────────────────────────────────────────────────
  if (commandName === 'kick') {
    const user   = interaction.options.getUser('uzytkownik');
    const reason = interaction.options.getString('powod') || 'Brak powodu';
    try {
      const member = await interaction.guild.members.fetch(user.id);
      if (!member.kickable) return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie mogę wyrzucić tego użytkownika (wyższe uprawnienia).')], ephemeral: true });
      await member.kick(reason);
      await sendModLog(interaction.guild, 'KICK', user, interaction.user, reason, '#ff6b00');
      return interaction.reply({ embeds: [embed('#ff6b00', '👢 Użytkownik wyrzucony', `<@${user.id}> został/a wyrzucony/a.\nPowód: ${reason}`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie udało się wyrzucić użytkownika.')], ephemeral: true });
    }
  }

  // ── ban ───────────────────────────────────────────────────────────────
  if (commandName === 'ban') {
    const user   = interaction.options.getUser('uzytkownik');
    const reason = interaction.options.getString('powod') || 'Brak powodu';
    try {
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (member && !member.bannable) return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie mogę zbanować tego użytkownika (wyższe uprawnienia).')], ephemeral: true });
      await interaction.guild.members.ban(user.id, { reason });
      await sendModLog(interaction.guild, 'BAN', user, interaction.user, reason, '#ff0000');
      return interaction.reply({ embeds: [embed('#ff0000', '🔨 Użytkownik zbanowany', `<@${user.id}> został/a zbanowany/a.\nPowód: ${reason}`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie udało się zbanować użytkownika.')], ephemeral: true });
    }
  }

  // ── unban ─────────────────────────────────────────────────────────────
  if (commandName === 'unban') {
    const id = interaction.options.getString('id');
    try {
      await interaction.guild.members.unban(id);
      await sendModLog(interaction.guild, 'UNBAN', { tag: `ID: ${id}`, id }, interaction.user, 'Ręczne odbanowanie', '#2ed573');
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Odbanowano', `Użytkownik o ID \`${id}\` został/a odbanowany/a.`)], ephemeral: true });
    } catch {
      return interaction.reply({ embeds: [embed('#ff4757', '❌ Błąd', 'Nie znaleziono bana lub nieprawidłowe ID.')], ephemeral: true });
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
          color: '#747d8c',
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
        ephemeral: true
      });
    }
    if (sub === 'on')  { gc.verification.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ Weryfikacja włączona',  'System weryfikacji jest aktywny.')],     ephemeral: true }); }
    if (sub === 'off') { gc.verification.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ Weryfikacja wyłączona', 'System weryfikacji jest nieaktywny.')], ephemeral: true }); }
    if (sub === 'panel') {
      await sendVerifyPanel(interaction.channel);
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Panel wysłany', `Panel weryfikacyjny wysłany na <#${interaction.channel.id}>.`)], ephemeral: true });
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
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Tickety skonfigurowane', `Rola supportu: <@&${role.id}>${logsCh ? `\nLogi: <#${logsCh.id}>` : ''}`)], ephemeral: true });
    }
    if (sub === 'on')  { gc.tickets.enabled = true;  saveConfig(); return interaction.reply({ embeds: [embed('#2ed573', '✅ Tickety włączone',  'System ticketów aktywny.')],     ephemeral: true }); }
    if (sub === 'off') { gc.tickets.enabled = false; saveConfig(); return interaction.reply({ embeds: [embed('#ff4757', '❌ Tickety wyłączone', 'System ticketów nieaktywny.')], ephemeral: true }); }
    if (sub === 'panel') {
      await sendTicketPanel(interaction.channel);
      return interaction.reply({ embeds: [embed('#2ed573', '✅ Panel wysłany', `Panel ticketów na <#${interaction.channel.id}>.`)], ephemeral: true });
    }
  }
  // ── botserver ──────────────────────────────────────────────────
  if (commandName === 'botserver') {
    const sub = interaction.options.getSubcommand();
    const SUPPORT_GUILD_ID = process.env.SUPPORT_GUILD_ID || '1492793536930910310';

    if (interaction.guild.id !== SUPPORT_GUILD_ID) {
      return interaction.reply({
        content: '❌ Ta komenda działa tylko na oficjalnym serwerze FenixExelent.',
        ephemeral: true,
      });
    }

    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: '❌ Tylko administrator może użyć tej komendy.',
        ephemeral: true,
      });
    }

    if (sub === 'setup') {
      await interaction.deferReply({ ephemeral: true });
      await setupOfficialBotServer(interaction.guild);

      return interaction.editReply({
        content: '✅ Oficjalny serwer supportowy FenixExelent został skonfigurowany.',
      });
    }

    if (sub === 'refresh') {
      await interaction.deferReply({ ephemeral: true });
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
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('verify_btn')
      .setLabel('✅ Verify / Zweryfikuj się')
      .setStyle(ButtonStyle.Success)
  );

  await channel.send({
    embeds: [new EmbedBuilder()
      .setColor('#ff6b00')
      .setTitle('✅ Weryfikacja / Verification — FenixExelent')
      .setDescription(
        '🇵🇱 **Polski**\n' +
        'Aby uzyskać dostęp do serwera, kliknij przycisk poniżej.\n\n' +
        '📜 Upewnij się, że przeczytałeś/aś regulamin.\n' +
        'Klikając przycisk, potwierdzasz akceptację zasad serwera.\n\n' +
        '━━━━━━━━━━━━━━━━━━━━\n\n' +
        '🇬🇧 **English**\n' +
        'To access the server, click the button below.\n\n' +
        '📜 Make sure you have read the rules.\n' +
        'By clicking the button, you confirm that you accept the server rules.'
      )
      .setFooter({ text: 'FenixExelent 🔥' })
      .setTimestamp()
    ],
    components: [row],
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
    const errMsg = { content: '❌ Wystąpił błąd.', ephemeral: true };
    if (!interaction.replied && !interaction.deferred) await interaction.reply(errMsg).catch(() => {});
  }
});

async function handleButton(interaction, gc) {

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
      ephemeral: true,
    });
  }

  // ── Lockdown Toggle ──
  if (interaction.customId === 'lockdown_toggle') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ Brak uprawnień administratora.', ephemeral: true });
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
    )], ephemeral: true });
  }

// ── Verification Button ──
if (interaction.customId === 'verify_btn') {
  if (!gc.verification.enabled) {
    return interaction.reply({
      content: '❌ Weryfikacja jest aktualnie wyłączona.',
      ephemeral: true
    });
  }

  if (!gc.verification.roleId) {
    return interaction.reply({
      content: '❌ Rola weryfikacji nie jest skonfigurowana. Admin musi użyć `/verification setup`.',
      ephemeral: true
    });
  }

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (member.roles.cache.has(gc.verification.roleId)) {
      return interaction.reply({
        content: '✅ Jesteś już zweryfikowany/a!',
        ephemeral: true
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
      ephemeral: true
    });

  } catch (err) {
    console.error('Verify error:', err);

    return interaction.reply({
      content: '❌ Wystąpił błąd podczas weryfikacji.',
      ephemeral: true
    });
  }
}
  // ── Ticket Open ──
  if (interaction.customId === 'ticket_open') {
    if (!gc.tickets.enabled) {
      return interaction.reply({ content: '❌ System ticketów jest wyłączony.', ephemeral: true });
    }
    const userId = interaction.user.id;
    if (gc.tickets.openTickets[userId]) {
      const existing = interaction.guild.channels.cache.get(gc.tickets.openTickets[userId]);
      if (existing) return interaction.reply({ content: `❌ Masz już otwarty ticket <#${existing.id}>`, ephemeral: true });
      delete gc.tickets.openTickets[userId];
    }
    await interaction.deferReply({ ephemeral: true });
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

    if (!canClose) return interaction.reply({ content: '❌ Brak uprawnień do zamknięcia.', ephemeral: true });

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
      return interaction.reply({ content: '❌ Tylko support może przejąć ticket.', ephemeral: true });
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
  });
});

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