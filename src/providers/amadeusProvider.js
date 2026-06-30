import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

const HOSTS = {
  test: 'https://test.api.amadeus.com',
  production: 'https://api.amadeus.com'
};

// Amadeus for Developers Self-Service provider (flight offers search).
// Free self-service tier: a client id/secret obtains an OAuth2 token that is
// reused until shortly before expiry. Enabled only when credentials are set.
// https://developers.amadeus.com/self-service/category/flights
export class AmadeusProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'amadeus',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.clientId = options.clientId || null;
    this.clientSecret = options.clientSecret || null;
    this.baseUrl = options.baseUrl || HOSTS[options.environment] || HOSTS.test;
    this.maxResults = Number.isFinite(options.maxResults) ? options.maxResults : 10;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.token = null; // { accessToken, expiresAt }
  }

  get ready() {
    return this.enabled && Boolean(this.clientId && this.clientSecret);
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
      configured: Boolean(this.clientId && this.clientSecret)
    };
  }

  async authToken() {
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
    const expiresInMs = (Number(payload.expires_in) || 0) * 1000;
    this.token = { accessToken: payload.access_token, expiresAt: this.now() + expiresInMs };
    return this.token.accessToken;
  }

  async search(type, query = {}) {
    if (type !== 'flights') return [];

    const token = await this.authToken();
    const params = new URLSearchParams({
      originLocationCode: String(query.from || '').toUpperCase(),
      destinationLocationCode: String(query.to || '').toUpperCase(),
      departureDate: String(query.date || ''),
      adults: String(query.adults || '1'),
      currencyCode: 'USD',
      max: String(this.maxResults)
    });
    if (query.returnDate) params.set('returnDate', String(query.returnDate));
    if (query.children) params.set('children', String(query.children));
    if (query.cabin) params.set('travelClass', String(query.cabin).toUpperCase());

    const payload = await fetchJson(`${this.baseUrl}/v2/shopping/flight-offers?${params.toString()}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
    });

    const offers = Array.isArray(payload?.data) ? payload.data : [];
    return offers.map((offer) => this.toOffer(offer));
  }

  toOffer(offer) {
    const itineraries = Array.isArray(offer.itineraries) ? offer.itineraries : [];
    const segments = itineraries.flatMap((it) => (Array.isArray(it.segments) ? it.segments : []));
    const first = segments[0];
    const last = segments[segments.length - 1];
    const carriers = [...new Set(segments.map((s) => s.carrierCode).filter(Boolean))];
    // Stops are per leg: a leg with N segments has N-1 stops. Summing across legs
    // would conflate the outbound and return journeys, so score on the worst leg.
    const stopsPerLeg = itineraries.map((it) => Math.max(0, (Array.isArray(it.segments) ? it.segments.length : 0) - 1));
    const stops = stopsPerLeg.length ? Math.max(...stopsPerLeg) : 0;

    return normalizeOffer({
      type: 'flights',
      provider: this.name,
      id: `amadeus-${offer.id}`,
      // Amadeus grandTotal is the verified all-in fare (base + taxes + fees).
      price: {
        amount: Number(offer.price?.grandTotal ?? offer.price?.total),
        total: Number(offer.price?.grandTotal ?? offer.price?.total),
        base: offer.price?.base !== undefined ? Number(offer.price.base) : null,
        currency: offer.price?.currency || 'USD',
        estimated: false
      },
      freshness: 'live',
      title: first && last
        ? `${first.departure?.iataCode} → ${last.arrival?.iataCode} (${carriers.join('/') || 'multi'})`
        : 'Flight offer',
      affiliateId: this.affiliateId,
      details: {
        carriers,
        stops,
        stopsPerLeg,
        oneWay: itineraries.length <= 1,
        bookableSeats: offer.numberOfBookableSeats ?? null,
        departure: first?.departure ?? null,
        arrival: last?.arrival ?? null,
        segments: segments.map((s) => ({
          from: s.departure?.iataCode ?? null,
          to: s.arrival?.iataCode ?? null,
          at: s.departure?.at ?? null,
          carrier: s.carrierCode ?? null,
          number: s.number ?? null
        }))
      },
      // Fewer stops ranks higher when sorting by score.
      score: 100 - stops * 10
    });
  }
}
