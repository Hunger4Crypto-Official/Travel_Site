import { fetchJson } from '../utils/httpClient.js';

export const AMADEUS_HOSTS = {
  test: 'https://test.api.amadeus.com',
  production: 'https://api.amadeus.com'
};

// Shared Amadeus OAuth2 client-credentials helper with token caching, so every
// Amadeus-backed provider reuses one token-acquisition implementation.
export class AmadeusAuth {
  constructor({ clientId, clientSecret, baseUrl, environment, fetchImpl, timeoutMs, now } = {}) {
    this.clientId = clientId || null;
    this.clientSecret = clientSecret || null;
    this.baseUrl = baseUrl || AMADEUS_HOSTS[environment] || AMADEUS_HOSTS.test;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
    this.now = now || (() => Date.now());
    this.token = null;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async accessToken() {
    if (this.token && this.token.expiresAt - 30000 > this.now()) {
      return this.token.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret
    }).toString();

    const payload = await fetchJson(`${this.baseUrl}/v1/security/oauth2/token`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body
    });

    if (!payload?.access_token) {
      throw new Error('Amadeus did not return an access token');
    }
    this.token = {
      accessToken: payload.access_token,
      expiresAt: this.now() + (Number(payload.expires_in) || 0) * 1000
    };
    return this.token.accessToken;
  }
}
