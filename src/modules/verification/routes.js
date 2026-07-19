'use strict';

const { VerificationError } = require('./errors');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page({ title, heading, message, content = '', tone = 'blue' }) {
  const colors = tone === 'green'
    ? { accent: '#22c55e', glow: 'rgba(34,197,94,.18)' }
    : tone === 'red'
      ? { accent: '#ef4444', glow: 'rgba(239,68,68,.18)' }
      : { accent: '#3b82f6', glow: 'rgba(59,130,246,.18)' };
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>
<style>:root{color-scheme:dark;--accent:${colors.accent};--glow:${colors.glow}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top,var(--glow),transparent 42%),#050712;color:#f8fbff;font-family:Inter,Segoe UI,Arial,sans-serif;padding:24px}.card{width:min(540px,100%);background:linear-gradient(180deg,#0d1428,#080d1d);border:1px solid rgba(96,165,250,.24);border-radius:22px;padding:30px;box-shadow:0 24px 80px rgba(0,0,0,.45)}.brand{font-weight:900;letter-spacing:.04em;color:#f59e0b;margin-bottom:24px}h1{font-size:28px;margin:0 0 12px}p{color:#b6c4df;line-height:1.65}.meta{background:#050814;border:1px solid rgba(96,165,250,.16);border-radius:12px;padding:12px;margin:18px 0}.button,button{display:inline-flex;justify-content:center;width:100%;border:0;border-radius:12px;padding:13px 17px;background:linear-gradient(135deg,var(--accent),#2563eb);color:white;font:inherit;font-weight:800;cursor:pointer;text-decoration:none;margin-top:16px}.turnstile{display:flex;justify-content:center;min-height:70px;margin:20px 0 8px}.small{font-size:13px;color:#7f91b3}</style>
</head><body><main class="card"><div class="brand">🔥 Fenix Secure Verification v4</div><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>${content}</main></body></html>`;
}

function challengePage(info) {
  const siteKey = escapeHtml(info.webConfiguration.siteKey);
  const content = `<div class="meta"><b>Serwer:</b> ${escapeHtml(info.guildName)}<br><b>Link ważny do:</b> ${escapeHtml(new Date(info.expiresAt).toLocaleString('pl-PL'))}</div>
<form method="post" action="/verification/challenge">
  <div class="turnstile"><div class="cf-turnstile" data-sitekey="${siteKey}" data-action="fenix_verify" data-theme="dark"></div></div>
  <button type="submit">Potwierdź i zaloguj przez Discord</button>
</form><p class="small">Token jest jednorazowy. Konto Discord musi być tym samym kontem, które kliknęło przycisk na serwerze.</p>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`;
  return page({
    title: 'Fenix Secure Verification',
    heading: 'Potwierdź, że jesteś człowiekiem',
    message: 'Ukończ Cloudflare Turnstile, a następnie zaloguj się przez Discord OAuth2.',
    content,
  });
}

function errorResponse(res, error) {
  const known = error instanceof VerificationError;
  const status = known ? error.status : 500;
  const message = known ? error.message : 'Wystąpił błąd podczas weryfikacji.';
  return res.status(status).type('html').send(page({
    title: 'Weryfikacja nieudana',
    heading: 'Nie udało się ukończyć weryfikacji',
    message,
    tone: 'red',
    content: '<p class="small">Wróć na Discord i kliknij przycisk Verify, aby rozpocząć nową sesję.</p>',
  }));
}

function mountVerificationRoutes(app, { manager, logger }) {
  app.use(['/verify', '/verification'], (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.get('/verify/:token', (req, res) => {
    try {
      const info = manager.sessionInfo(String(req.params.token || ''));
      req.session.verificationSessionId = info.id;
      return req.session.save(() => res.redirect(303, '/verification/challenge'));
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.get('/verification/challenge', (req, res) => {
    try {
      const info = manager.sessionInfoById(String(req.session.verificationSessionId || ''));
      if (!info.webConfiguration.oauthConfigured || !info.webConfiguration.turnstileConfigured) {
        throw new VerificationError('verification_not_configured', 'Administrator musi skonfigurować Discord OAuth2 i Cloudflare Turnstile.', 503);
      }
      return res.type('html').send(challengePage(info));
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.post('/verification/challenge', async (req, res) => {
    try {
      const turnstileToken = String(req.body?.['cf-turnstile-response'] || '');
      await manager.verifyTurnstileById(String(req.session.verificationSessionId || ''), turnstileToken, req.ip || req.socket.remoteAddress || '');
      return res.redirect(303, '/verification/oauth');
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.get('/verification/oauth', (req, res) => {
    try {
      const url = manager.beginOAuthById(String(req.session.verificationSessionId || ''));
      return res.redirect(302, url);
    } catch (error) {
      return errorResponse(res, error);
    }
  });

  app.get('/verification/callback', async (req, res) => {
    try {
      const result = await manager.completeOAuth({
        state: String(req.query.state || ''),
        code: String(req.query.code || ''),
      });
      delete req.session.verificationSessionId;
      if (!result.completed && result.pendingMethods.includes('language')) {
        return res.type('html').send(page({
          title: 'Weryfikacja WWW zakończona',
          heading: 'Pierwszy etap ukończony',
          message: 'Wróć na oficjalny serwer supportu i wybierz język pod panelem weryfikacji.',
          tone: 'green',
        }));
      }
      return res.type('html').send(page({
        title: 'Weryfikacja zakończona',
        heading: 'Weryfikacja zakończona pomyślnie',
        message: 'Rola została nadana. Możesz bezpiecznie wrócić na Discord.',
        tone: 'green',
      }));
    } catch (error) {
      logger.warn({ code: error.code || 'unknown' }, 'Verification callback failed');
      return errorResponse(res, error);
    }
  });
}

module.exports = { mountVerificationRoutes, escapeHtml };
