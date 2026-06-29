export class BaseProvider {
  constructor({ name, enabled = true, apiKey = null, affiliateId = null, timeoutMs = 8000 } = {}) {
    this.name = name;
    this.enabled = enabled;
    this.apiKey = apiKey;
    this.affiliateId = affiliateId;
    this.timeoutMs = timeoutMs;
  }

  get ready() {
    return this.enabled;
  }

  supports() {
    return false;
  }

  async search() {
    return [];
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: []
    };
  }
}
