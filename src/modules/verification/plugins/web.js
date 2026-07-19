'use strict';

const crypto = require('crypto');
const axios = require('axios');
const { VerificationError } = require('../errors');

function createWebVerificationPlugin(options = {}) {
  const clientId = String(options.clientId || process.env.CLIENT_ID || '').trim();
  const clientSecret = String(options.clientSecret || process.env.CLIENT_SECRET || '').trim();
  const redirectUri = String(options.redirectUri || process.env.VERIFICATION_REDIRECT_URI || '').trim();
  const siteKey = String(options.siteKey || process.env.TURNSTILE_SITE_KEY || '').trim();
  const secretKey = String(options.secretKey || process.env.TURNSTILE_SECRET_KEY || '').trim();
  const expectedHostname = String(options.expectedHostname || process.env.TURNSTILE_EXPECTED_HOSTNAME || '').trim().toLowerCase();
  const http = options.http || axios;

  return {
    id: 'web',
    label: 'Web Verification',
    description: 'Discord OAuth2 + Cloudflare Turnstile + jednorazowa sesja WWW.',
    version: '4.0.0',
    officialOnly: true,
    configurable: false,

    configuration() {
      return {
        oauthConfigured: Boolean(clientId && clientSecret && redirectUri),
        turnstileConfigured: Boolean(siteKey && secretKey),
        siteKey,
        redirectUri,
      };
    },

    authorizationUrl(state) {
      if (!clientId || !clientSecret || !redirectUri) {
        throw new VerificationError('oauth_not_configured', 'Discord OAuth2 nie jest skonfigurowany.', 503);
      }
      const url = new URL('https://discord.com/oauth2/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', 'identify');
      url.searchParams.set('state', state);
      url.searchParams.set('prompt', 'consent');
      return url.toString();
    },

    async verifyTurnstile(responseToken, remoteIp) {
      if (!siteKey || !secretKey) {
        throw new VerificationError('turnstile_not_configured', 'Cloudflare Turnstile nie jest skonfigurowany.', 503);
      }
      const token = String(responseToken || '');
      if (!token || token.length > 2048) {
        throw new VerificationError('turnstile_invalid', 'Nie ukończono zabezpieczenia Turnstile.', 400);
      }
      const body = new URLSearchParams({
        secret: secretKey,
        response: token,
        idempotency_key: crypto.randomUUID(),
      });
      if (remoteIp) body.set('remoteip', String(remoteIp));

      let result;
      try {
        const response = await http.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', body, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        });
        result = response.data || {};
      } catch {
        throw new VerificationError('turnstile_unavailable', 'Nie udało się połączyć z Cloudflare Turnstile.', 503);
      }
      if (!result.success) {
        throw new VerificationError('turnstile_rejected', 'Cloudflare Turnstile odrzucił próbę. Odśwież stronę i spróbuj ponownie.', 400);
      }
      if (String(result.action || '') !== 'fenix_verify') {
        throw new VerificationError('turnstile_action_mismatch', 'Odpowiedź Turnstile nie pasuje do formularza.', 400);
      }
      if (expectedHostname && String(result.hostname || '').toLowerCase() !== expectedHostname) {
        throw new VerificationError('turnstile_hostname_mismatch', 'Odpowiedź Turnstile pochodzi z nieprawidłowej domeny.', 400);
      }
      return { success: true, hostname: result.hostname || null };
    },

    async exchangeCode(code) {
      if (!clientId || !clientSecret || !redirectUri) {
        throw new VerificationError('oauth_not_configured', 'Discord OAuth2 nie jest skonfigurowany.', 503);
      }
      try {
        const tokenResponse = await http.post('https://discord.com/api/oauth2/token', new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code: String(code || ''),
          redirect_uri: redirectUri,
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 });
        const accessToken = String(tokenResponse.data?.access_token || '');
        if (!accessToken) throw new Error('missing_access_token');
        const userResponse = await http.get('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15_000,
        });
        return userResponse.data;
      } catch {
        throw new VerificationError('oauth_exchange_failed', 'Logowanie Discord nie powiodło się.', 400);
      }
    },

    async validate({ session, evidence }) {
      if (!session.turnstileVerified) return { ok: false, code: 'turnstile_required' };
      if (!evidence?.discordUser?.id || String(evidence.discordUser.id) !== session.userId) {
        return { ok: false, code: 'discord_user_mismatch' };
      }
      return { ok: true, userId: String(evidence.discordUser.id) };
    },
  };
}

module.exports = { createWebVerificationPlugin };
