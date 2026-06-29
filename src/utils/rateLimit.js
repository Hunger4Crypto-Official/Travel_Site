export class TokenBucketRateLimiter {
  constructor({ capacity = 60, refillPerMinute = 60 } = {}) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMinute = refillPerMinute;
    this.updatedAt = Date.now();
  }

  consume(tokens = 1) {
    this.refill();
    if (this.tokens < tokens) return false;
    this.tokens -= tokens;
    return true;
  }

  refill() {
    const now = Date.now();
    const elapsedMinutes = (now - this.updatedAt) / 60000;
    const refillAmount = elapsedMinutes * this.refillPerMinute;
    this.tokens = Math.min(this.capacity, this.tokens + refillAmount);
    this.updatedAt = now;
  }
}
