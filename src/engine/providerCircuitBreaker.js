export class ProviderCircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 30000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = new Map();
  }

  canCall(providerName) {
    const state = this.state.get(providerName);
    if (!state || state.openUntil <= Date.now()) return true;
    return false;
  }

  recordSuccess(providerName) {
    this.state.set(providerName, { failures: 0, openUntil: 0 });
  }

  recordFailure(providerName) {
    const current = this.state.get(providerName) || { failures: 0, openUntil: 0 };
    const failures = current.failures + 1;
    const openUntil = failures >= this.failureThreshold ? Date.now() + this.cooldownMs : 0;
    this.state.set(providerName, { failures, openUntil });
  }

  status(providerName) {
    const current = this.state.get(providerName) || { failures: 0, openUntil: 0 };
    return {
      failures: current.failures,
      open: current.openUntil > Date.now(),
      openUntil: current.openUntil || null
    };
  }
}
