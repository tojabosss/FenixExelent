'use strict';

const crypto = require('crypto');
const { PermissionFlagsBits } = require('discord.js');
const { VerificationError } = require('./errors');

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

class VerificationManager {
  constructor(options) {
    this.client = options.client;
    this.getGuildConfig = options.getGuildConfig;
    this.database = options.database;
    this.logger = options.logger;
    this.baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
    this.isOfficialSupportGuild = options.isOfficialSupportGuild;
    this.sessions = options.sessions;
    this.rateLimiter = options.rateLimiter;
    this.plugins = options.plugins;
    this.ipHashKey = String(process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
  }

  listMethods(guildId) {
    const guild = this.client.guilds.cache.get(String(guildId));
    return this.plugins.list({ officialGuild: Boolean(guild && this.isOfficialSupportGuild(guild)) });
  }

  environmentReadiness() {
    const web = this.plugins.get('web');
    const configuration = web.configuration();
    const persistentStorage = this.database.databaseType === 'postgresql';
    const missing = [];
    if (!configuration.oauthConfigured) missing.push('discord_oauth');
    if (!configuration.turnstileConfigured) missing.push('cloudflare_turnstile');
    if (!persistentStorage) missing.push('persistent_database');
    return {
      oauthConfigured: configuration.oauthConfigured,
      turnstileConfigured: configuration.turnstileConfigured,
      persistentStorage,
      ready: configuration.oauthConfigured && configuration.turnstileConfigured,
      missing,
    };
  }

  readiness(guildId) {
    const guild = this.client.guilds.cache.get(String(guildId));
    const gc = guild ? this.getGuildConfig(guild.id) : null;
    const environment = this.environmentReadiness();
    const enabled = Boolean(gc?.verification?.enabled);
    const roleConfigured = Boolean(gc?.verification?.roleId);
    const channelConfigured = Boolean(gc?.verification?.channelId);
    const issues = [...environment.missing];
    if (!enabled) issues.push('verification_disabled');
    if (!roleConfigured) issues.push('verified_role_missing');
    if (!channelConfigured) issues.push('panel_channel_missing');
    return {
      ...environment,
      guildAvailable: Boolean(guild),
      officialSupportGuild: Boolean(guild && this.isOfficialSupportGuild(guild)),
      enabled,
      roleConfigured,
      channelConfigured,
      ready: Boolean(guild && enabled && roleConfigured && environment.ready),
      issues,
    };
  }

  resolveMethods(guild, gc) {
    const configured = Array.isArray(gc.verification?.methods) ? gc.verification.methods : ['web'];
    const available = new Set(this.plugins.list({ officialGuild: this.isOfficialSupportGuild(guild) }).map(item => item.id));
    const methods = configured.filter(method => available.has(method));
    if (!methods.includes('web')) methods.unshift('web');
    if (this.isOfficialSupportGuild(guild) && gc.supportLanguages?.enabled !== false) {
      if (!methods.includes('language')) methods.push('language');
    } else {
      const languageIndex = methods.indexOf('language');
      if (languageIndex >= 0) methods.splice(languageIndex, 1);
    }
    return [...new Set(methods)];
  }

  limits(gc) {
    return {
      maxAttempts: clamp(gc.verification?.maxAttempts, 1, 20, 5),
      windowMs: clamp(gc.verification?.rateLimitWindowMinutes, 1, 60, 10) * 60 * 1000,
      ttlMs: clamp(gc.verification?.sessionTtlMinutes, 2, 30, 5) * 60 * 1000,
    };
  }

  async startSession({ guildId, userId }) {
    const guild = this.client.guilds.cache.get(String(guildId));
    if (!guild) throw new VerificationError('guild_not_found', 'Bot nie jest dostępny na tym serwerze.', 404);
    const gc = this.getGuildConfig(guild.id);
    if (!gc.verification?.enabled) throw new VerificationError('verification_disabled', 'Weryfikacja jest wyłączona na tym serwerze.', 409);
    if (!gc.verification.roleId) throw new VerificationError('role_not_configured', 'Administrator nie skonfigurował roli po weryfikacji.', 409);
    if (!this.baseUrl) throw new VerificationError('base_url_missing', 'Publiczny adres dashboardu nie jest skonfigurowany.', 503);

    const methods = this.resolveMethods(guild, gc);
    const member = await guild.members.fetch(String(userId)).catch(() => null);
    if (!member) throw new VerificationError('member_not_found', 'Nie znaleziono użytkownika na tym serwerze.', 404);
    if (member.roles.cache.has(gc.verification.roleId) && !methods.includes('language')) {
      if (gc.verification.unverifiedRoleId) await member.roles.remove(gc.verification.unverifiedRoleId).catch(() => {});
      return { alreadyVerified: true, guildName: guild.name };
    }

    const limits = this.limits(gc);
    const rate = this.rateLimiter.consume(`user:${guild.id}:${userId}`, {
      limit: limits.maxAttempts,
      windowMs: limits.windowMs,
    });
    if (!rate.allowed) {
      throw new VerificationError('rate_limited', `Za dużo prób. Spróbuj ponownie za ${Math.ceil(rate.retryAfterMs / 60_000)} min.`, 429);
    }

    const created = this.sessions.create({ guildId: guild.id, userId, methods, ttlMs: limits.ttlMs });
    await this.audit(created.session, 'verification_started', { methods });
    return {
      alreadyVerified: false,
      url: `${this.baseUrl}/verify/${created.token}`,
      expiresAt: created.session.expiresAt,
      methods,
      guildName: guild.name,
    };
  }

  sessionInfo(token) {
    const session = this.sessions.getByToken(token);
    return this.buildSessionInfo(session);
  }

  sessionInfoById(sessionId) {
    return this.buildSessionInfo(this.sessions.getById(sessionId));
  }

  buildSessionInfo(session) {
    const guild = this.client.guilds.cache.get(session.guildId);
    const web = this.plugins.get('web');
    return {
      ...this.sessions.publicView(session),
      guildName: guild?.name || 'Discord',
      webConfiguration: web.configuration(),
    };
  }

  hashIp(ip) {
    if (!ip) return 'unknown';
    return crypto.createHmac('sha256', this.ipHashKey).update(String(ip)).digest('hex').slice(0, 16);
  }

  async verifyTurnstile(token, responseToken, remoteIp) {
    return this.verifyTurnstileSession(this.sessions.getByToken(token), responseToken, remoteIp);
  }

  async verifyTurnstileById(sessionId, responseToken, remoteIp) {
    return this.verifyTurnstileSession(this.sessions.getById(sessionId), responseToken, remoteIp);
  }

  async verifyTurnstileSession(session, responseToken, remoteIp) {
    const gc = this.getGuildConfig(session.guildId);
    const limits = this.limits(gc);
    const ipHash = this.hashIp(remoteIp);
    const rate = this.rateLimiter.consume(`ip:${ipHash}`, {
      limit: Math.max(10, limits.maxAttempts * 3),
      windowMs: limits.windowMs,
    });
    if (!rate.allowed) throw new VerificationError('rate_limited', 'Za dużo prób z tego połączenia.', 429);

    this.sessions.incrementAttemptsByHash(session.tokenHash);
    const web = this.plugins.get('web');
    try {
      const result = await web.verifyTurnstile(responseToken, remoteIp);
      const updated = this.sessions.markTurnstileByHash(session.tokenHash);
      await this.audit(updated, 'verification_turnstile_passed', { ipHash, hostname: result.hostname });
      return updated;
    } catch (error) {
      await this.audit(this.sessions.publicView(session), 'verification_turnstile_failed', { ipHash, code: error.code || 'unknown' });
      throw error;
    }
  }

  beginOAuth(token) {
    const session = this.sessions.getByToken(token);
    return this.beginOAuthSession(session);
  }

  beginOAuthById(sessionId) {
    return this.beginOAuthSession(this.sessions.getById(sessionId));
  }

  beginOAuthSession(session) {
    if (!session.methods.includes('web')) throw new VerificationError('web_not_required', 'Weryfikacja WWW nie jest aktywna.', 409);
    const state = this.sessions.createOAuthStateByHash(session.tokenHash);
    return this.plugins.get('web').authorizationUrl(state);
  }

  async completeOAuth({ state, code }) {
    if (!code) throw new VerificationError('oauth_code_missing', 'Discord nie zwrócił kodu autoryzacyjnego.', 400);
    const session = this.sessions.consumeOAuthState(state);
    const view = this.sessions.publicView(session);
    const web = this.plugins.get('web');
    let discordUser;
    try {
      discordUser = await web.exchangeCode(code);
      const validation = await web.validate({ session: view, evidence: { discordUser } });
      if (!validation.ok) {
        this.sessions.failByHash(session.tokenHash, validation.code);
        await this.audit(view, 'verification_oauth_mismatch', { code: validation.code });
        throw new VerificationError(validation.code, 'Zalogowano inne konto Discord niż to, które rozpoczęło weryfikację.', 403);
      }
      const updated = this.sessions.markMethodByHash(session.tokenHash, 'web');
      await this.audit(updated, 'verification_oauth_passed', {});
      return this.finalizeIfReady(session.tokenHash);
    } catch (error) {
      if (error.code !== 'discord_user_mismatch') {
        await this.audit(view, 'verification_oauth_failed', { code: error.code || 'unknown' });
      }
      throw error;
    }
  }

  languageReadiness(guildId, userId) {
    const session = this.sessions.findActive(guildId, userId);
    if (!session) return { ready: false, reason: 'missing_session' };
    if (!session.methods.includes('language')) return { ready: false, reason: 'language_not_required' };
    if (!session.completedMethods.includes('web')) return { ready: false, reason: 'web_required' };
    return { ready: true, session: this.sessions.publicView(session) };
  }

  async completeLanguage({ guildId, userId, languageCode }) {
    const session = this.sessions.findActive(guildId, userId);
    if (!session) throw new VerificationError('missing_session', 'Najpierw rozpocznij weryfikację WWW.', 409);
    const guild = this.client.guilds.cache.get(String(guildId));
    const plugin = this.plugins.get('language');
    const validation = await plugin.validate({
      session: this.sessions.publicView(session),
      officialGuild: Boolean(guild && this.isOfficialSupportGuild(guild)),
      evidence: { languageCode, rolesApplied: true },
    });
    if (!validation.ok) throw new VerificationError(validation.code, 'Nie udało się potwierdzić wyboru języka.', 409);
    const updated = this.sessions.markMethodByHash(session.tokenHash, 'language');
    await this.audit(updated, 'verification_language_passed', { languageCode: validation.languageCode });
    return this.finalizeIfReady(session.tokenHash, { roleAlreadyAssigned: true });
  }

  async finalizeIfReady(tokenHash, { roleAlreadyAssigned = false } = {}) {
    const session = this.sessions.getByHash(tokenHash);
    const pendingMethods = session.methods.filter(method => !session.completedMethods.includes(method));
    if (pendingMethods.length) {
      return { completed: false, pendingMethods, session: this.sessions.publicView(session) };
    }
    try {
      if (!roleAlreadyAssigned) await this.assignVerifiedRole(session);
      const completed = this.sessions.completeByHash(tokenHash);
      await this.audit(completed, 'verification_completed', { methods: completed.methods });
      await this.discordLog(completed, true, 'Weryfikacja zakończona pomyślnie.');
      return { completed: true, pendingMethods: [], session: completed };
    } catch (error) {
      this.sessions.failByHash(tokenHash, 'role_assignment_failed');
      await this.audit(this.sessions.publicView(session), 'verification_role_failed', { code: error.code || 'unknown' });
      await this.discordLog(this.sessions.publicView(session), false, 'Nie udało się nadać roli po weryfikacji.');
      if (error instanceof VerificationError) throw error;
      throw new VerificationError('role_assignment_failed', 'Nie udało się nadać roli. Administrator musi sprawdzić uprawnienia bota.', 500);
    }
  }

  async assignVerifiedRole(session) {
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) throw new VerificationError('guild_not_found', 'Serwer nie jest dostępny.', 404);
    const gc = this.getGuildConfig(guild.id);
    const [member, botMember, verifiedRole] = await Promise.all([
      guild.members.fetch(session.userId).catch(() => null),
      guild.members.fetchMe().catch(() => guild.members.me),
      gc.verification?.roleId ? guild.roles.fetch(gc.verification.roleId).catch(() => null) : null,
    ]);
    if (!member) throw new VerificationError('member_not_found', 'Użytkownik opuścił serwer.', 404);
    if (!verifiedRole || verifiedRole.managed) throw new VerificationError('role_not_found', 'Rola weryfikacji nie istnieje.', 409);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new VerificationError('manage_roles_missing', 'Bot nie ma uprawnienia Zarządzanie rolami.', 409);
    }
    if (botMember.roles.highest.comparePositionTo(verifiedRole) <= 0) {
      throw new VerificationError('role_hierarchy', 'Rola bota jest zbyt nisko w hierarchii.', 409);
    }
    await member.roles.add(verifiedRole, 'Fenix Secure Verification v4');
    if (gc.verification.unverifiedRoleId) {
      await member.roles.remove(gc.verification.unverifiedRoleId, 'Fenix Secure Verification v4: zweryfikowano').catch(() => {});
    }
  }

  async audit(session, eventType, payload) {
    try {
      await this.database.writeAudit({
        guildId: session.guildId,
        userId: session.userId,
        eventType,
        payload: { sessionId: session.id, ...payload },
      });
    } catch (error) {
      this.logger.warn({ err: error, eventType }, 'Verification audit write failed');
    }
  }

  async discordLog(session, success, description) {
    const guild = this.client.guilds.cache.get(session.guildId);
    if (!guild) return;
    const channelId = this.getGuildConfig(session.guildId).verification?.logChannelId;
    if (!channelId) return;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;
    await channel.send({ embeds: [{
      color: success ? 0x22c55e : 0xef4444,
      title: success ? 'Fenix Verification: sukces' : 'Fenix Verification: błąd',
      description,
      fields: [
        { name: 'Użytkownik', value: `<@${session.userId}>`, inline: true },
        { name: 'Metody', value: session.methods.join(' → '), inline: true },
        { name: 'Sesja', value: `\`${session.id}\``, inline: false },
      ],
      timestamp: new Date().toISOString(),
    }] }).catch(() => {});
  }

  close() {
    this.sessions.close();
    this.rateLimiter.close();
  }
}

module.exports = { VerificationManager };
