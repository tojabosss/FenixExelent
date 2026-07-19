'use strict';

const { SessionManager } = require('./SessionManager');
const { RateLimiter } = require('./RateLimiter');
const { PluginRegistry } = require('./PluginRegistry');
const { VerificationManager } = require('./VerificationManager');
const { createWebVerificationPlugin } = require('./plugins/web');
const { discordVerificationPlugin } = require('./plugins/discord');
const { languageVerificationPlugin } = require('./plugins/language');
const { mountVerificationRoutes } = require('./routes');

function createVerificationManager(options) {
  const redirectUri = String(process.env.VERIFICATION_REDIRECT_URI || `${String(options.baseUrl || '').replace(/\/$/, '')}/verification/callback`);
  const plugins = new PluginRegistry();
  plugins.register(createWebVerificationPlugin({ redirectUri }));
  plugins.register(discordVerificationPlugin);
  plugins.register(languageVerificationPlugin);
  return new VerificationManager({
    ...options,
    sessions: new SessionManager(),
    rateLimiter: new RateLimiter(),
    plugins,
  });
}

module.exports = {
  createVerificationManager,
  mountVerificationRoutes,
  SessionManager,
  RateLimiter,
  PluginRegistry,
  VerificationManager,
};
