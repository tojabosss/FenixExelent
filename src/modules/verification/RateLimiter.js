'use strict';

class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  consume(key, { limit, windowMs }) {
    const now = Date.now();
    const safeLimit = Math.max(1, Number(limit) || 1);
    const safeWindow = Math.max(1_000, Number(windowMs) || 60_000);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const next = { count: 1, resetAt: now + safeWindow };
      this.buckets.set(key, next);
      return { allowed: true, remaining: safeLimit - 1, retryAfterMs: 0 };
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= safeLimit,
      remaining: Math.max(0, safeLimit - bucket.count),
      retryAfterMs: Math.max(0, bucket.resetAt - now),
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }

  close() {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}

module.exports = { RateLimiter };
