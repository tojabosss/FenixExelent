'use strict';

const assert = require('assert');
const {
  SessionManager,
  RateLimiter,
  PluginRegistry,
  VerificationManager,
} = require('../src/modules/verification');
const { createWebVerificationPlugin } = require('../src/modules/verification/plugins/web');
const { languageVerificationPlugin } = require('../src/modules/verification/plugins/language');

async function main() {
  const standaloneSessions = new SessionManager({ defaultTtlMs: 120_000 });
  const created = standaloneSessions.create({ guildId: '1', userId: '2', methods: ['web'] });
  assert(created.token.length >= 32);
  assert(!JSON.stringify(created.session).includes(created.token));
  standaloneSessions.markTurnstile(created.token);
  const oauthState = standaloneSessions.createOAuthState(created.token);
  const oauthSession = standaloneSessions.consumeOAuthState(oauthState);
  assert.strictEqual(oauthSession.userId, '2');
  assert.throws(() => standaloneSessions.consumeOAuthState(oauthState), error => error.code === 'invalid_oauth_state');
  standaloneSessions.close();

  const rateLimiter = new RateLimiter();
  assert.strictEqual(rateLimiter.consume('user', { limit: 2, windowMs: 60_000 }).allowed, true);
  assert.strictEqual(rateLimiter.consume('user', { limit: 2, windowMs: 60_000 }).allowed, true);
  assert.strictEqual(rateLimiter.consume('user', { limit: 2, windowMs: 60_000 }).allowed, false);
  rateLimiter.close();

  const http = {
    async post(url) {
      if (url.includes('siteverify')) return { data: { success: true, action: 'fenix_verify', hostname: 'verify.example' } };
      if (url.includes('/oauth2/token')) return { data: { access_token: 'test-access-token' } };
      throw new Error(`Unexpected POST ${url}`);
    },
    async get(url) {
      if (url.endsWith('/users/@me')) return { data: { id: '222222222222222222', username: 'tester' } };
      throw new Error(`Unexpected GET ${url}`);
    },
  };

  const plugins = new PluginRegistry();
  plugins.register(createWebVerificationPlugin({
    clientId: '111111111111111111',
    clientSecret: 'test-client-secret',
    redirectUri: 'https://verify.example/verification/callback',
    siteKey: 'test-site-key',
    secretKey: 'test-secret-key',
    expectedHostname: 'verify.example',
    http,
  }));
  plugins.register(languageVerificationPlugin);
  assert.deepStrictEqual(plugins.list().map(item => item.id), ['web']);
  assert.deepStrictEqual(plugins.list({ officialGuild: true }).map(item => item.id), ['web', 'language']);

  const rolesCache = new Map();
  const verifiedRole = { id: '333333333333333333', managed: false };
  rolesCache.set(verifiedRole.id, verifiedRole);
  const memberRoleCache = new Map();
  const member = {
    roles: {
      cache: memberRoleCache,
      async add(role) { memberRoleCache.set(role.id, role); },
      async remove(roleId) { memberRoleCache.delete(String(roleId)); },
    },
  };
  const botMember = {
    permissions: { has: () => true },
    roles: { highest: { comparePositionTo: () => 1 } },
  };
  const guild = {
    id: '111111111111111111',
    name: 'Test Guild',
    members: {
      async fetch(userId) { return userId === '222222222222222222' ? member : null; },
      async fetchMe() { return botMember; },
      me: botMember,
    },
    roles: {
      cache: rolesCache,
      async fetch(roleId) { return rolesCache.get(String(roleId)) || null; },
    },
    channels: { async fetch() { return null; } },
  };
  const guilds = new Map([[guild.id, guild]]);
  guilds.cache = guilds;
  const config = {
    verification: {
      enabled: true,
      roleId: verifiedRole.id,
      unverifiedRoleId: null,
      methods: ['web'],
      sessionTtlMinutes: 5,
      maxAttempts: 5,
      rateLimitWindowMinutes: 10,
    },
    supportLanguages: { enabled: false },
  };
  const auditEvents = [];
  const manager = new VerificationManager({
    client: { guilds },
    getGuildConfig: () => config,
    database: { databaseType: 'postgresql', async writeAudit(event) { auditEvents.push(event); } },
    logger: { warn() {} },
    baseUrl: 'https://verify.example',
    isOfficialSupportGuild: () => false,
    sessions: new SessionManager(),
    rateLimiter: new RateLimiter(),
    plugins,
  });

  assert.deepStrictEqual(manager.environmentReadiness().missing, []);
  assert.strictEqual(manager.readiness(guild.id).ready, true);
  assert.strictEqual(manager.readiness(guild.id).officialSupportGuild, false);

  const started = await manager.startSession({ guildId: guild.id, userId: '222222222222222222' });
  const token = new URL(started.url).pathname.split('/').pop();
  await manager.verifyTurnstile(token, 'turnstile-response', '127.0.0.1');
  const authorizationUrl = new URL(manager.beginOAuth(token));
  const result = await manager.completeOAuth({ state: authorizationUrl.searchParams.get('state'), code: 'oauth-code' });
  assert.strictEqual(result.completed, true);
  assert.strictEqual(memberRoleCache.has(verifiedRole.id), true);
  assert(auditEvents.some(event => event.eventType === 'verification_completed'));
  assert.throws(() => manager.sessionInfo(token), error => error.code === 'used_token');
  manager.close();

  console.log('OK: tokeny jednorazowe, rate limit, pluginy, Turnstile, OAuth2 i nadawanie roli.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
