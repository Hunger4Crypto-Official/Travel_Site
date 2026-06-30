import { createHash } from 'node:crypto';
import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';
import { resolveCityCode } from '../utils/geo.js';

const HOSTS = {
  test: 'https://api.test.hotelbeds.com',
  production: 'https://api.hotelbeds.com'
};

// Hotelbeds APItude availability provider (hotels).
// Auth uses an Api-key header plus an X-Signature = SHA256(apiKey + secret +
// unixSeconds). A destination requires a Hotelbeds/IATA city code, supplied via
// the optional `cityCode` query parameter. Enabled only when credentials are
// configured. https://developer.hotelbeds.com/documentation/hotels/
export class HotelbedsProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'hotelbeds',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.apiKey = options.apiKey || null;
    this.secret = options.secret || null;
    this.baseUrl = options.baseUrl || HOSTS[options.environment] || HOSTS.test;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => Date.now());
  }

  get ready() {
    return this.enabled && Boolean(this.apiKey && this.secret);
  }

  supports(type) {
    return type === 'hotels';
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: ['hotels'],
      configured: Boolean(this.apiKey && this.secret)
    };
  }

  signature() {
    const seconds = Math.floor(this.now() / 1000);
    return createHash('sha256').update(`${this.apiKey}${this.secret}${seconds}`).digest('hex');
  }

  async search(type, query = {}) {
    if (type !== 'hotels') return [];

    // Hotelbeds needs a destination code; accept an explicit cityCode or resolve
    // a free-text city name (e.g. "Las Vegas" -> "LAS") from the bundled dataset.
    const destinationCode = resolveCityCode(query.cityCode || query.city) || '';
    if (!/^[A-Z]{3}$/.test(destinationCode)) return [];

    const body = JSON.stringify({
      stay: { checkIn: query.checkin, checkOut: query.checkout },
      occupancies: [{
        rooms: clampInt(query.rooms, 1, 8, 1),
        adults: clampInt(query.adults, 1, 8, 1),
        children: clampInt(query.children, 0, 8, 0)
      }],
      destination: { code: destinationCode }
    });

    const payload = await fetchJson(`${this.baseUrl}/hotel-api/1.0/hotels`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      method: 'POST',
      headers: {
        'Api-key': this.apiKey,
        'X-Signature': this.signature(),
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body
    });

    const hotels = Array.isArray(payload?.hotels?.hotels) ? payload.hotels.hotels : [];
    return hotels.map((hotel) => this.toOffer(hotel));
  }

  toOffer(hotel) {
    return normalizeOffer({
      type: 'hotels',
      provider: this.name,
      id: `hotelbeds-${hotel.code}`,
      // minRate is a "from" net rate; taxes/fees vary, so treat as an estimate.
      price: { amount: Number(hotel.minRate), total: Number(hotel.minRate), currency: hotel.currency || 'USD', estimated: true },
      freshness: 'live',
      title: hotel.name || `Hotel ${hotel.code}`,
      affiliateId: this.affiliateId,
      details: {
        code: hotel.code ?? null,
        category: hotel.categoryName ?? null,
        destination: hotel.destinationName ?? null,
        zone: hotel.zoneName ?? null,
        rooms: Array.isArray(hotel.rooms) ? hotel.rooms.length : null
      },
      score: categoryScore(hotel.categoryName)
    });
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function categoryScore(categoryName) {
  const match = /^(\d)/.exec(String(categoryName || ''));
  return match ? Number(match[1]) * 20 : null;
}
