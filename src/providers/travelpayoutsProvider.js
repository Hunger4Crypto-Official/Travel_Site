import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

const DEFAULT_BASE_URL = 'https://api.travelpayouts.com';

// Travelpayouts (Aviasales) Data API provider for cached cheapest flight prices.
// Free for partners registered in the affiliate network; the Flight Search API
// (live) requires 50k+ MAU, so this uses the cached prices_for_dates endpoint.
// Enabled only when a token is configured. https://travelpayouts.github.io/slate/
export class TravelpayoutsProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'travelpayouts',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.token = options.token || null;
    this.marker = options.marker || null;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.currency = options.currency || 'usd';
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  get ready() {
    return this.enabled && Boolean(this.token);
  }

  supports(type) {
    return type === 'flights';
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: ['flights'],
      configured: Boolean(this.token)
    };
  }

  async search(type, query = {}) {
    if (type !== 'flights') return [];

    const params = new URLSearchParams({
      origin: String(query.from || '').toUpperCase(),
      destination: String(query.to || '').toUpperCase(),
      currency: this.currency,
      unique: 'false',
      sorting: 'price',
      limit: '30',
      one_way: query.returnDate ? 'false' : 'true'
    });
    // The cached endpoint accepts a YYYY-MM or YYYY-MM-DD departure filter.
    if (query.date) params.set('departure_at', String(query.date));
    if (query.returnDate) params.set('return_at', String(query.returnDate));

    const payload = await fetchJson(`${this.baseUrl}/aviasales/v3/prices_for_dates?${params.toString()}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: { 'X-Access-Token': this.token, accept: 'application/json' }
    });

    if (payload && payload.success === false) {
      throw new Error(`Travelpayouts error: ${payload.error || 'request rejected'}`);
    }
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data.map((entry, index) => this.toOffer(entry, index));
  }

  toOffer(entry, index) {
    const currency = (entry.currency || this.currency || 'USD').toUpperCase();
    return normalizeOffer({
      type: 'flights',
      provider: this.name,
      id: `travelpayouts-${entry.origin}-${entry.destination}-${entry.departure_at || index}`,
      price: Number(entry.price),
      currency,
      title: `${entry.origin} → ${entry.destination}${entry.airline ? ` (${entry.airline})` : ''}`,
      deepLink: entry.link ? `https://www.aviasales.com${entry.link}` : null,
      affiliateId: this.affiliateId || this.marker,
      details: {
        origin: entry.origin ?? null,
        destination: entry.destination ?? null,
        airline: entry.airline ?? null,
        flightNumber: entry.flight_number ?? null,
        departureAt: entry.departure_at ?? null,
        returnAt: entry.return_at ?? null,
        transfers: entry.transfers ?? null,
        cached: true
      },
      score: Number.isFinite(Number(entry.transfers)) ? 100 - Number(entry.transfers) * 10 : null
    });
  }
}
