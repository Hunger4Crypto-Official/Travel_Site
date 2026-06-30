import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';
import { AmadeusAuth } from './amadeusAuth.js';
import { resolveCityCode } from '../utils/geo.js';

// Amadeus Hotel Search (hotels). Two-step per the Self-Service API: resolve the
// city's hotels, then fetch live offers. Prices are verified all-in totals.
// https://developers.amadeus.com/self-service/category/hotels
export class AmadeusHotelsProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'amadeus-hotels',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.auth = new AmadeusAuth({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      environment: options.environment,
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      now: options.now
    });
    this.baseUrl = this.auth.baseUrl;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxHotels = Number.isFinite(options.maxHotels) ? options.maxHotels : 20;
  }

  get ready() {
    return this.enabled && this.auth.configured;
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
      configured: this.auth.configured
    };
  }

  async search(type, query = {}) {
    if (type !== 'hotels') return [];
    const cityCode = resolveCityCode(query.cityCode || query.city);
    if (!cityCode) return [];

    const token = await this.auth.accessToken();
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };

    const list = await fetchJson(
      `${this.baseUrl}/v1/reference-data/locations/hotels/by-city?cityCode=${encodeURIComponent(cityCode)}`,
      { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, headers }
    );
    const hotelIds = (Array.isArray(list?.data) ? list.data : [])
      .map((h) => h.hotelId)
      .filter(Boolean)
      .slice(0, this.maxHotels);
    if (hotelIds.length === 0) return [];

    const params = new URLSearchParams({ hotelIds: hotelIds.join(','), adults: String(query.adults || '1') });
    if (query.checkin) params.set('checkInDate', String(query.checkin));
    if (query.checkout) params.set('checkOutDate', String(query.checkout));
    if (query.rooms) params.set('roomQuantity', String(query.rooms));

    const payload = await fetchJson(
      `${this.baseUrl}/v3/shopping/hotel-offers?${params.toString()}`,
      { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, headers }
    );
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data.map((entry) => this.toOffer(entry)).filter(Boolean);
  }

  toOffer(entry) {
    const hotel = entry.hotel || {};
    const offers = Array.isArray(entry.offers) ? entry.offers : [];
    if (offers.length === 0) return null;
    const cheapest = offers.reduce(
      (min, o) => (Number(o.price?.total) < Number(min.price?.total) ? o : min),
      offers[0]
    );
    const price = cheapest.price || {};
    return normalizeOffer({
      type: 'hotels',
      provider: this.name,
      id: `amadeus-hotel-${hotel.hotelId || 'x'}`,
      price: {
        amount: Number(price.total),
        total: Number(price.total),
        base: price.base !== undefined ? Number(price.base) : null,
        currency: price.currency || 'USD',
        estimated: false
      },
      freshness: 'live',
      title: hotel.name || `Hotel ${hotel.hotelId}`,
      affiliateId: this.affiliateId,
      details: {
        hotelId: hotel.hotelId ?? null,
        city: hotel.cityCode ?? null,
        location: (hotel.latitude != null && hotel.longitude != null)
          ? { lat: hotel.latitude, lon: hotel.longitude }
          : null,
        room: cheapest.room?.description?.text ?? null,
        checkIn: cheapest.checkInDate ?? null,
        checkOut: cheapest.checkOutDate ?? null
      }
    });
  }
}
