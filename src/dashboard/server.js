'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { sanitizeConfigPatch } = require('./configValidation');

const USER_ID_PATTERN = /^\d{15,22}$/;

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of hits) if (value.resetAt <= now) hits.delete(key);
  }, Math.max(30_000, windowMs));
  timer.unref();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const value = hits.get(key);
    if (!value || value.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    value.count += 1;
    if (value.count > max) return res.status(429).json({ error: 'Za dużo żądań. Spróbuj ponownie za chwilę.' });
    next();
  };
}

function requiredInvitePermissions() {
  const permissions = [
    PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels, PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageMessages, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ViewChannel,
  ];
  return permissions.reduce((sum, permission) => sum | permission, 0n).toString();
}

function safeReason(value) {
  return String(value || 'Brak powodu').trim().slice(0, 500) || 'Brak powodu';
}

async function startDashboardServer(options) {
  const {
    client, config, database, logger, getGuildConfig, saveConfig,
    sendVerifyPanel, sendTicketPanel, enableEmergencyMode, disableEmergencyMode,
    createServerBackup, restoreServerBackup, updateStats, calculateServerSecurityScore,
    aggregateSecurityStats, formatUptime, sendModLog, policyHtml, createReactionRolesPanelForChannel,
  } = options;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://discord.com");
    next();
  });
  app.use(express.json({ limit: '256kb', strict: true }));

  let store;
  if (database.pool) {
    const PgStore = require('connect-pg-simple')(session);
    store = new PgStore({ pool: database.pool, createTableIfMissing: true, tableName: 'user_sessions' });
  } else if (process.env.NODE_ENV === 'production') {
    logger.warn('Dashboard sessions use memory storage. Configure DATABASE_URL for production persistence.');
  }

  const sessionSecret = String(process.env.SESSION_SECRET || 'development-only-session-secret-change-me');
  app.use(session({
    name: 'fenix.sid', secret: sessionSecret, store,
    resave: false, saveUninitialized: false, proxy: true,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax', httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    },
  }));

  app.use('/api', createRateLimiter({ windowMs: 60_000, max: 180 }));
  const authLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
  app.use(express.static(path.join(__dirname, '..', '..', 'dashboard', 'public'), { extensions: ['html'] }));

  const requireAuth = (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Niezalogowany' });
    next();
  };
  const hasAdminOnGuild = (req, guildId) => {
    if (!Array.isArray(req.session.guilds)) return false;
    const ownerId = String(process.env.OWNER_ID || '').trim();
    if (ownerId && req.session.user?.id === ownerId) return true;
    const guild = req.session.guilds.find(item => item.id === guildId);
    if (!guild) return false;
    try { return (BigInt(guild.permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator; }
    catch { return false; }
  };
  const requireGuildAdmin = (req, res, next) => {
    if (!hasAdminOnGuild(req, req.params.guildId)) return res.status(403).json({ error: 'Brak uprawnień administratora' });
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Bot nie jest na tym serwerze' });
    req.discordGuild = guild;
    next();
  };

  const clientId = String(process.env.CLIENT_ID || '').trim();
  const clientSecret = String(process.env.CLIENT_SECRET || '').trim();
  const redirectUri = process.env.REDIRECT_URI || `${config.dashboardUrl}/callback`;

  app.get('/invite', (req, res) => {
    if (!clientId) return res.status(503).send('Brak CLIENT_ID w konfiguracji bota.');
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('permissions', requiredInvitePermissions());
    url.searchParams.set('scope', 'bot applications.commands');
    res.redirect(url.toString());
  });

  app.get('/login', authLimiter, (req, res) => {
    if (!clientId || !clientSecret) return res.status(503).send('Logowanie Discord nie jest skonfigurowane.');
    const state = crypto.randomBytes(24).toString('hex');
    req.session.oauthState = state;
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/dashboard.html')));

  app.get('/callback', authLimiter, async (req, res) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    if (!code || !state || state !== req.session.oauthState) return res.redirect('/dashboard.html?error=invalid_state');
    delete req.session.oauthState;
    try {
      const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code',
        code, redirect_uri: redirectUri,
      }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 });
      const authorization = { Authorization: `Bearer ${tokenResponse.data.access_token}` };
      const [userResponse, guildsResponse] = await Promise.all([
        axios.get('https://discord.com/api/users/@me', { headers: authorization, timeout: 15_000 }),
        axios.get('https://discord.com/api/users/@me/guilds', { headers: authorization, timeout: 15_000 }),
      ]);
      req.session.user = userResponse.data;
      req.session.guilds = guildsResponse.data;
      return req.session.save(() => res.redirect('/dashboard.html'));
    } catch (error) {
      logger.error('OAuth2 error:', error.response?.data || error.message);
      return res.redirect('/dashboard.html?error=auth_failed');
    }
  });

  app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.json({ loggedIn: false });
    const user = req.session.user;
    res.json({ loggedIn: true, user: {
      id: user.id, username: user.username,
      avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
    } });
  });

  app.get('/api/guilds', requireAuth, (req, res) => {
    const botGuildIds = new Set(client.guilds.cache.keys());
    const ownerId = String(process.env.OWNER_ID || '').trim();
    const guilds = (req.session.guilds || []).filter(item => {
      let isAdmin = false;
      try { isAdmin = (BigInt(item.permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator; } catch {}
      return (isAdmin || (ownerId && req.session.user.id === ownerId)) && botGuildIds.has(item.id);
    }).map(item => ({
      id: item.id, name: item.name, hasBot: true,
      icon: item.icon ? `https://cdn.discordapp.com/icons/${item.id}/${item.icon}.png` : null,
      memberCount: client.guilds.cache.get(item.id)?.memberCount || null,
    }));
    res.json(guilds);
  });

  app.get('/api/guild/:guildId/meta', requireAuth, requireGuildAdmin, async (req, res) => {
    const guild = req.discordGuild;
    await Promise.all([guild.channels.fetch().catch(() => {}), guild.roles.fetch().catch(() => {})]);
    const channels = guild.channels.cache
      .filter(channel => channel.type === ChannelType.GuildText)
      .map(channel => ({ id: channel.id, name: channel.name })).sort((a, b) => a.name.localeCompare(b.name));
    const categories = guild.channels.cache
      .filter(channel => channel.type === ChannelType.GuildCategory)
      .map(channel => ({ id: channel.id, name: channel.name })).sort((a, b) => a.name.localeCompare(b.name));
    const roles = guild.roles.cache
      .filter(role => !role.managed && role.id !== guild.roles.everyone.id)
      .map(role => ({ id: role.id, name: role.name })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ channels, categories, roles });
  });

  app.get('/api/config/:guildId', requireAuth, requireGuildAdmin, (req, res) => res.json(getGuildConfig(req.params.guildId)));

  app.post('/api/config/:guildId', requireAuth, requireGuildAdmin, async (req, res) => {
    const guildId = req.params.guildId;
    const guild = req.discordGuild;
    try {
      const { patch, actions } = sanitizeConfigPatch(req.body);
      const gc = getGuildConfig(guildId);
      const oldLockdown = !!gc.antiraid?.lockdownActive;
      for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) gc[key] = Object.assign(gc[key] || {}, value);
        else gc[key] = value;
      }

      const actionResults = {};
      if (patch.antiraid?.lockdownActive !== undefined && patch.antiraid.lockdownActive !== oldLockdown) {
        let failed = 0;
        await guild.channels.fetch().catch(() => {});
        for (const [, channel] of guild.channels.cache) {
          if (channel.type !== ChannelType.GuildText) continue;
          await channel.permissionOverwrites.edit(guild.roles.everyone, {
            SendMessages: patch.antiraid.lockdownActive ? false : null,
          }).catch(() => { failed += 1; });
        }
        actionResults.lockdown = { active: patch.antiraid.lockdownActive, failed };
      }
      if (actions.sendVerificationPanel) {
        const channel = gc.verification?.channelId ? await guild.channels.fetch(gc.verification.channelId).catch(() => null) : null;
        if (!channel?.isTextBased?.()) return res.status(400).json({ error: 'Wybierz kanał panelu weryfikacji' });
        await sendVerifyPanel(channel);
        actionResults.verificationPanel = true;
      }
      if (actions.sendTicketPanel) {
        const channelId = gc.tickets?.panelChannelId || gc.tickets?.logChannelId;
        const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
        if (!channel?.isTextBased?.()) return res.status(400).json({ error: 'Wybierz kanał panelu ticketów' });
        await sendTicketPanel(channel);
        actionResults.ticketPanel = true;
      }
      if (actions.emergencyOn) actionResults.emergency = await enableEmergencyMode(guild, gc);
      if (actions.emergencyOff) actionResults.emergency = await disableEmergencyMode(guild, gc);
      if (actions.createBackup) {
        const backup = createServerBackup(guild, gc);
        actionResults.backup = { id: backup.id, createdAt: backup.createdAt };
      }
      if (actions.restoreBackupId) {
        const result = await restoreServerBackup(guild, gc, actions.restoreBackupId);
        if (!result) return res.status(404).json({ error: 'Nie znaleziono backupu' });
        actionResults.restore = result;
      }
      if (actions.refreshStats) {
        await updateStats(guild);
        actionResults.statsRefreshed = true;
      }
      if (actions.createReactionRolesPanel) {
        const channelId = gc.reactionRoles?.channelId;
        const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
        if (!channel?.isTextBased?.()) return res.status(400).json({ error: 'Wybierz kanał panelu Reaction Roles' });
        actionResults.reactionRoles = await createReactionRolesPanelForChannel(channel);
      }

      await saveConfig();
      database.writeAudit({ guildId, userId: req.session.user.id, eventType: 'dashboard_config_updated', payload: { keys: Object.keys(patch), actions: Object.keys(actions).filter(key => actions[key]) } });
      res.json({ success: true, config: gc, actionResults });
    } catch (error) {
      logger.error(`Dashboard config save error (${guildId}):`, error);
      const status = error instanceof TypeError ? 400 : 500;
      res.status(status).json({ error: status === 400 ? 'Nieprawidłowe dane formularza' : 'Nie udało się zapisać ustawień', details: process.env.NODE_ENV === 'production' ? undefined : error.message });
    }
  });

  app.get('/api/security/:guildId', requireAuth, requireGuildAdmin, (req, res) => {
    const gc = getGuildConfig(req.params.guildId);
    const backups = Object.values(gc.backups || {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(item => ({ id: item.id, createdAt: item.createdAt, channels: item.channels?.length || 0, roles: item.roles?.length || 0 }));
    const appeals = Object.values(gc.appeals?.cases || {}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50);
    res.json({ score: calculateServerSecurityScore(gc), stats: gc.securityStats || {}, backups, appeals, emergencyActive: !!gc.emergency?.active });
  });

  app.get('/api/risk/:guildId/:userId', requireAuth, requireGuildAdmin, (req, res) => {
    if (!USER_ID_PATTERN.test(req.params.userId)) return res.status(400).json({ error: 'Nieprawidłowe ID użytkownika' });
    const gc = getGuildConfig(req.params.guildId);
    res.json(gc.antiscam?.riskScores?.[req.params.userId] || { score: 0, events: [] });
  });

  app.get('/api/mod/:guildId/warns/:userId', requireAuth, requireGuildAdmin, (req, res) => {
    if (!USER_ID_PATTERN.test(req.params.userId)) return res.status(400).json({ error: 'Nieprawidłowe ID użytkownika' });
    res.json(getGuildConfig(req.params.guildId).warns?.[req.params.userId] || []);
  });

  app.post('/api/mod/:guildId/:action', requireAuth, requireGuildAdmin, async (req, res) => {
    const { guildId, action } = req.params;
    const guild = req.discordGuild;
    const userId = String(req.body?.userId || '').trim();
    const reason = safeReason(req.body?.reason);
    if (!USER_ID_PATTERN.test(userId)) return res.status(400).json({ error: 'Nieprawidłowe ID użytkownika' });
    const gc = getGuildConfig(guildId);
    try {
      if (action === 'warn') {
        if (!gc.warns[userId]) gc.warns[userId] = [];
        gc.warns[userId].push({ reason, mod: req.session.user.username, date: new Date().toISOString() });
        await saveConfig();
        await sendModLog(guild, 'WARN', { id: userId, tag: userId }, req.session.user, reason, '#ffa502');
        return res.json({ success: true, count: gc.warns[userId].length });
      }
      if (action === 'clearwarns') {
        const count = gc.warns?.[userId]?.length || 0;
        gc.warns[userId] = [];
        await saveConfig();
        return res.json({ success: true, cleared: count });
      }
      if (action === 'unban') {
        await guild.members.unban(userId, reason);
        return res.json({ success: true });
      }
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return res.status(404).json({ error: 'Nie znaleziono użytkownika na serwerze' });
      if (action === 'kick') {
        if (!member.kickable) return res.status(409).json({ error: 'Bot nie może wyrzucić tego użytkownika' });
        await member.kick(reason);
      } else if (action === 'ban') {
        if (!member.bannable) return res.status(409).json({ error: 'Bot nie może zbanować tego użytkownika' });
        await member.ban({ reason });
      } else if (action === 'unmute') {
        if (!member.moderatable) return res.status(409).json({ error: 'Bot nie może zmienić wyciszenia tego użytkownika' });
        await member.timeout(null, reason);
      } else {
        return res.status(404).json({ error: 'Nieznana akcja moderacyjna' });
      }
      await sendModLog(guild, action.toUpperCase(), member.user, req.session.user, reason, '#ff6b00');
      database.writeAudit({ guildId, userId: req.session.user.id, eventType: `dashboard_mod_${action}`, payload: { targetId: userId, reason } });
      res.json({ success: true });
    } catch (error) {
      logger.error(`Dashboard moderation error (${action}, ${guildId}):`, error);
      res.status(500).json({ error: 'Nie udało się wykonać akcji', details: process.env.NODE_ENV === 'production' ? undefined : error.message });
    }
  });

  app.get('/privacy', (req, res) => res.type('html').send(policyHtml('privacy')));
  app.get('/terms', (req, res) => res.type('html').send(policyHtml('terms')));
  app.get('/about', (req, res) => res.type('html').send(policyHtml('about')));
  app.get('/support', (req, res) => res.type('html').send(policyHtml('support')));

  function liveStatsPayload() {
    const discordReady = client.isReady();
    const members = client.guilds.cache.reduce((sum, guild) => sum + Math.max(0, Number(guild.memberCount) || 0), 0);
    const rawPing = Number(client.ws.ping);
    const ping = discordReady && Number.isFinite(rawPing) && rawPing >= 0 ? Math.round(rawPing) : null;
    const uptime = Math.floor(process.uptime());
    return {
      discordReady,
      guilds: client.guilds.cache.size,
      memberships: members,
      members,
      users: members,
      bots: null,
      total: members,
      uptime,
      ping,
      generatedAt: new Date().toISOString(),
      security: aggregateSecurityStats(),
    };
  }

  app.get('/api/stats', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(liveStatsPayload());
  });
  app.get('/api/public-status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const stats = liveStatsPayload();
    res.json({ name: client.user?.username || 'FenixExelentSecurity', ...stats, uptimeText: formatUptime(stats.uptime) });
  });
  app.get('/ping', (req, res) => res.json({ ok: true, discordReady: client.isReady(), storage: database.databaseType, uptime: Math.floor(process.uptime()) }));

  return new Promise((resolve, reject) => {
    const server = app.listen(config.dashboardPort, () => {
      logger.info({ url: config.dashboardUrl, port: config.dashboardPort }, 'Dashboard started');
      resolve(server);
    });
    server.once('error', reject);
  });
}

module.exports = { startDashboardServer };
