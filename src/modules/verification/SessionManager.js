'use strict';

const crypto = require('crypto');
const { VerificationError } = require('./errors');

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

class SessionManager {
  constructor({ defaultTtlMs = 5 * 60 * 1000, maxSessions = 10_000 } = {}) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.sessionIds = new Map();
    this.userSessions = new Map();
    this.oauthStates = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  userKey(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  create({ guildId, userId, methods, ttlMs, metadata = {} }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = digest(token);
    const now = Date.now();
    const lifetime = Math.min(30 * 60 * 1000, Math.max(2 * 60 * 1000, Number(ttlMs) || this.defaultTtlMs));
    const key = this.userKey(guildId, userId);
    const previousHash = this.userSessions.get(key);
    if (previousHash) this.invalidateByHash(previousHash, 'superseded');

    const session = {
      id: crypto.randomUUID(),
      tokenHash,
      guildId: String(guildId),
      userId: String(userId),
      status: 'pending',
      methods: [...new Set(methods)],
      completedMethods: [],
      turnstileVerifiedAt: null,
      attempts: 0,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + lifetime).toISOString(),
      completedAt: null,
      failureCode: null,
      oauthStateHash: null,
      metadata: { ...metadata },
    };

    this.sessions.set(tokenHash, session);
    this.sessionIds.set(session.id, tokenHash);
    this.userSessions.set(key, tokenHash);
    this.enforceCapacity();
    return { token, session: this.publicView(session) };
  }

  publicView(session) {
    return {
      id: session.id,
      guildId: session.guildId,
      userId: session.userId,
      status: session.status,
      methods: [...session.methods],
      completedMethods: [...session.completedMethods],
      pendingMethods: session.methods.filter(method => !session.completedMethods.includes(method)),
      turnstileVerified: Boolean(session.turnstileVerifiedAt),
      attempts: session.attempts,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      completedAt: session.completedAt,
      failureCode: session.failureCode,
    };
  }

  getByToken(token, { allowFinished = false } = {}) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw new VerificationError('invalid_token', 'Link weryfikacyjny jest nieprawidłowy.', 404);
    }
    return this.getByHash(digest(token), { allowFinished });
  }

  getByHash(tokenHash, { allowFinished = false } = {}) {
    const session = this.sessions.get(tokenHash);
    if (!session) throw new VerificationError('invalid_token', 'Link weryfikacyjny nie istnieje.', 404);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.invalidateByHash(tokenHash, 'expired');
      throw new VerificationError('expired_token', 'Link weryfikacyjny wygasł.', 410);
    }
    if (!allowFinished && session.status !== 'pending') {
      throw new VerificationError('used_token', 'Ten link został już użyty albo unieważniony.', 410);
    }
    return session;
  }

  getById(sessionId, options = {}) {
    const tokenHash = this.sessionIds.get(String(sessionId || ''));
    if (!tokenHash) throw new VerificationError('invalid_session', 'Sesja weryfikacyjna nie istnieje.', 404);
    return this.getByHash(tokenHash, options);
  }

  findActive(guildId, userId) {
    const tokenHash = this.userSessions.get(this.userKey(guildId, userId));
    if (!tokenHash) return null;
    try { return this.getByHash(tokenHash); }
    catch { return null; }
  }

  incrementAttempts(token) {
    return this.incrementAttemptsByHash(this.getByToken(token).tokenHash);
  }

  incrementAttemptsByHash(tokenHash) {
    const session = this.getByHash(tokenHash);
    session.attempts += 1;
    return this.publicView(session);
  }

  markTurnstile(token) {
    return this.markTurnstileByHash(this.getByToken(token).tokenHash);
  }

  markTurnstileByHash(tokenHash) {
    const session = this.getByHash(tokenHash);
    session.turnstileVerifiedAt = new Date().toISOString();
    return this.publicView(session);
  }

  createOAuthState(token) {
    return this.createOAuthStateByHash(this.getByToken(token).tokenHash);
  }

  createOAuthStateByHash(tokenHash) {
    const session = this.getByHash(tokenHash);
    if (!session.turnstileVerifiedAt) {
      throw new VerificationError('turnstile_required', 'Najpierw ukończ zabezpieczenie Turnstile.', 409);
    }
    if (session.oauthStateHash) this.oauthStates.delete(session.oauthStateHash);
    const state = crypto.randomBytes(32).toString('base64url');
    const stateHash = digest(state);
    session.oauthStateHash = stateHash;
    this.oauthStates.set(stateHash, session.tokenHash);
    return state;
  }

  consumeOAuthState(state) {
    if (typeof state !== 'string' || !TOKEN_PATTERN.test(state)) {
      throw new VerificationError('invalid_oauth_state', 'Stan logowania Discord jest nieprawidłowy.', 400);
    }
    const stateHash = digest(state);
    const tokenHash = this.oauthStates.get(stateHash);
    this.oauthStates.delete(stateHash);
    if (!tokenHash) throw new VerificationError('invalid_oauth_state', 'Stan logowania Discord wygasł albo został użyty.', 410);
    const session = this.getByHash(tokenHash);
    if (session.oauthStateHash !== stateHash) {
      throw new VerificationError('invalid_oauth_state', 'Stan logowania Discord nie pasuje do sesji.', 400);
    }
    session.oauthStateHash = null;
    return session;
  }

  markMethodByHash(tokenHash, methodId) {
    const session = this.getByHash(tokenHash);
    if (!session.methods.includes(methodId)) {
      throw new VerificationError('method_not_required', 'Ta metoda nie jest częścią bieżącej weryfikacji.', 409);
    }
    if (!session.completedMethods.includes(methodId)) session.completedMethods.push(methodId);
    return this.publicView(session);
  }

  completeByHash(tokenHash) {
    const session = this.getByHash(tokenHash);
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    this.releaseIndexes(session);
    return this.publicView(session);
  }

  failByHash(tokenHash, code = 'failed') {
    const session = this.sessions.get(tokenHash);
    if (!session || session.status !== 'pending') return null;
    session.status = 'failed';
    session.failureCode = String(code).slice(0, 80);
    session.completedAt = new Date().toISOString();
    this.releaseIndexes(session);
    return this.publicView(session);
  }

  invalidateByHash(tokenHash, code = 'invalidated') {
    const session = this.sessions.get(tokenHash);
    if (!session) return;
    if (session.status === 'pending') {
      session.status = code === 'expired' ? 'expired' : 'invalidated';
      session.failureCode = code;
      session.completedAt = new Date().toISOString();
    }
    this.releaseIndexes(session);
  }

  releaseIndexes(session) {
    const key = this.userKey(session.guildId, session.userId);
    if (this.userSessions.get(key) === session.tokenHash) this.userSessions.delete(key);
    if (session.oauthStateHash) this.oauthStates.delete(session.oauthStateHash);
    session.oauthStateHash = null;
  }

  cleanup() {
    const now = Date.now();
    for (const [tokenHash, session] of this.sessions) {
      const expired = Date.parse(session.expiresAt) <= now;
      const finishedLongAgo = session.completedAt && Date.parse(session.completedAt) <= now - 10 * 60 * 1000;
      if (expired && session.status === 'pending') this.invalidateByHash(tokenHash, 'expired');
      if (finishedLongAgo || (expired && session.status !== 'pending')) this.sessions.delete(tokenHash);
      if (finishedLongAgo || (expired && session.status !== 'pending')) this.sessionIds.delete(session.id);
    }
  }

  enforceCapacity() {
    if (this.sessions.size <= this.maxSessions) return;
    const ordered = [...this.sessions.entries()].sort((a, b) => Date.parse(a[1].createdAt) - Date.parse(b[1].createdAt));
    for (const [tokenHash, session] of ordered.slice(0, this.sessions.size - this.maxSessions)) {
      this.invalidateByHash(tokenHash, 'capacity');
      this.sessions.delete(tokenHash);
      this.sessionIds.delete(session.id);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.sessions.clear();
    this.sessionIds.clear();
    this.userSessions.clear();
    this.oauthStates.clear();
  }
}

module.exports = { SessionManager };
