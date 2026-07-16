'use strict';

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
    scamReports: {},
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
      panelChannelId: null,
      openTickets: {},
    },
    supportLanguages: {
      enabled: true,
      guildId: null,
      verifyChannelId: null,
      categoryId: null,
      supported: ['pl', 'en', 'tr', 'de', 'fr'],
      roleIds: {},
      channelIds: {},
    },

verification: {
  enabled: false,
  roleId: null,
  unverifiedRoleId: null,
  channelId: null,
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

module.exports = { defaultGuildConfig };
