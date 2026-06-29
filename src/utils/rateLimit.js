export class TokenBucketRateLimiter {
  constructor({ capacity = 60, refillPerMinute = 60 } = {}) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMinute = refillPerMinute;
    this.updatedAt = Date.now();
  }

  consume(tokens = 1) {
    // Coerce a non-numeric argument (e.g. a client key passed by a keyed
    // wrapper) to a single token so the global limiter stays usable directly.
    const amount = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : 1;
    this.refill();
    if (this.tokens < amount) return false;
    this.tokens -= amount;
    return true;
  }

  refill() {
    const now = Date.now();
    const elapsedMinutes = (now - this.updatedAt) / 60000;
    const refillAmount = elapsedMinutes * this.refillPerMinute;
    this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    this.updatedAt = now;
  }

  // Whole seconds a client should wait for at least one token to refill.
  retryAfterSeconds() {
    return Math.max(1, Math.ceil(60 / (this.refillPerMinute || 1)));
  }
}

// Per-client rate limiting: each client key gets its own token bucket so one
// abusive caller cannot exhaust the quota for everyone. The number of tracked
// keys is bounded (LRU eviction) so the limiter itself cannot be turned into a
// memory-exhaustion vector.
export class KeyedRateLimiter {
  constructor({ capacity = 60, refillPerMinute = 60, maxKeys = 5000 } = {}) {
    this.capacity = capacity;
    this.refillPerMinute = refillPerMinute;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  consume(key = 'global', tokens = 1) {
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Refresh recency for LRU ordering.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    } else {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        this.buckets.delete(oldest);
      }
      bucket = new TokenBucketRateLimiter({ capacity: this.capacity, refillPerMinute: this.refillPerMinute });
      this.buckets.set(key, bucket);
    }
    return bucket.consume(tokens);
  }

  retryAfterSeconds() {
    return Math.max(1, Math.ceil(60 / (this.refillPerMinute || 1)));
  }
}
