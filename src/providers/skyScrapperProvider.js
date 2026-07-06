import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

const DEFAULT_BASE_URL = 'https://sky-scrapper.p.rapidapi.com';
const DEFAULT_RAPIDAPI_HOST = 'sky-scrapper.p.rapidapi.com';
const MAX_ITINERARIES = 20;

// Sky-Scrapper flight search provider (flights), via RapidAPI.
// Two-step flow: resolve each endpoint's skyId/entityId with searchAirport,
// then query searchFlights (v2). Skyscanner display prices are all-in totals
// (taxes and fees included), so offers rank as live, comparable prices.
// Airport resolutions are static, so they are cached for the process lifetime.
// https://rapidapi.com/apiheya/api/sky-scrapper
export class SkyScrapperProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'sky-scrapper',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.apiKey = options.apiKey || null;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.rapidApiHost = options.rapidApiHost || DEFAULT_RAPIDAPI_HOST;
    this.currency = (options.currency || 'USD').toUpperCase();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.placeCache = new Map();
  }

  get ready() {
    return this.enabled && Boolean(this.apiKey);
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
      configured: Boolean(this.apiKey)
    };
  }

  headers() {
    return {
      'X-RapidAPI-Key': this.apiKey,
      'X-RapidAPI-Host': this.rapidApiHost,
      accept: 'application/json'
    };
  }

  // Resolves an airport/city query (e.g. "LAX" or "New York") to the
  // { skyId, entityId } pair searchFlights requires. Prefers an exact skyId
  // match so a 3-letter code lands on the airport, not a broader city entity.
  async resolvePlace(value) {
    const query = String(value || '').trim();
    if (!query) return null;
    const cacheKey = query.toUpperCase();
    if (this.placeCache.has(cacheKey)) return this.placeCache.get(cacheKey);

    const payload = await fetchJson(`${this.baseUrl}/api/v1/flights/searchAirport?query=${encodeURIComponent(query)}&locale=en-US`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.headers()
    });

    const entries = Array.isArray(payload?.data) ? payload.data : [];
    const exact = entries.find((e) => String(e.skyId || '').toUpperCase() === cacheKey);
    const chosen = exact || entries[0];
    const params = chosen?.navigation?.relevantFlightParams || chosen;
    const place = params?.skyId && params?.entityId
      ? { skyId: String(params.skyId), entityId: String(params.entityId) }
      : null;

    if (place) this.placeCache.set(cacheKey, place);
    return place;
  }

  async search(type, query = {}) {
    if (type !== 'flights') return [];

    const [origin, destination] = await Promise.all([
      this.resolvePlace(query.from),
      this.resolvePlace(query.to)
    ]);
    if (!origin || !destination) return [];

    const params = new URLSearchParams({
      originSkyId: origin.skyId,
      destinationSkyId: destination.skyId,
      originEntityId: origin.entityId,
      destinationEntityId: destination.entityId,
      cabinClass: String(query.cabin || 'economy'),
      adults: String(clampInt(query.adults, 1, 8, 1)),
      sortBy: 'best', // ordering is irrelevant: the engine re-ranks by all-in total
      currency: this.currency,
      market: 'en-US',
      countryCode: 'US'
    });
    if (query.date) params.set('date', String(query.date));
    if (query.returnDate) params.set('returnDate', String(query.returnDate));

    const payload = await fetchJson(`${this.baseUrl}/api/v2/flights/searchFlights?${params.toString()}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.headers()
    });

    if (payload && payload.status === false) {
      throw new Error(`Sky-Scrapper error: ${describeApiError(payload)}`);
    }
    const itineraries = Array.isArray(payload?.data?.itineraries) ? payload.data.itineraries : [];
    return itineraries.slice(0, MAX_ITINERARIES)
      .map((itinerary) => this.toOffer(itinerary, query))
      .filter(Boolean);
  }

  toOffer(itinerary, query = {}) {
    const total = Number(itinerary?.price?.raw);
    if (!Number.isFinite(total)) return null;

    const legs = Array.isArray(itinerary.legs) ? itinerary.legs : [];
    const segments = legs.flatMap((leg) => (Array.isArray(leg.segments) ? leg.segments : []).map((seg) => ({
      carrier: seg.marketingCarrier?.alternateId ?? seg.marketingCarrier?.name ?? null,
      number: seg.flightNumber ?? null,
      at: seg.departure ?? null,
      from: seg.origin?.displayCode ?? seg.origin?.flightPlaceId ?? null,
      to: seg.destination?.displayCode ?? seg.destination?.flightPlaceId ?? null
    })));
    const [firstLeg] = legs;
    const stops = legs.reduce((worst, leg) => Math.max(worst, Number(leg.stopCount) || 0), 0);
    const carrierName = firstLeg?.carriers?.marketing?.[0]?.name || null;
    const route = firstLeg
      ? `${firstLeg.origin?.displayCode || '?'} → ${firstLeg.destination?.displayCode || '?'}`
      : 'Flight';

    // Route + date the offer represents, falling back to the search query so a
    // priced offer always yields an actionable Skyscanner deep link.
    const from = firstLeg?.origin?.displayCode || firstLeg?.origin?.flightPlaceId || query.from;
    const to = firstLeg?.destination?.displayCode || firstLeg?.destination?.flightPlaceId || query.to;
    const date = firstLeg?.departure || query.date;

    return normalizeOffer({
      type: 'flights',
      provider: this.name,
      id: `sky-scrapper-${itinerary.id || segments.map((s) => `${s.carrier}${s.number}`).join('-')}`,
      // Skyscanner display prices include taxes and fees: a comparable total.
      price: { amount: total, total, currency: this.currency, estimated: false },
      freshness: 'live',
      title: `${route}${carrierName ? ` (${carrierName})` : ''}`,
      deepLink: skyscannerDeepLink(itinerary, { from, to, date }, this.affiliateId),
      affiliateId: this.affiliateId,
      details: {
        segments,
        stops,
        durationMinutes: firstLeg?.durationInMinutes ?? null,
        departure: firstLeg?.departure ?? null,
        arrival: firstLeg?.arrival ?? null,
        tags: Array.isArray(itinerary.tags) ? itinerary.tags : []
      },
      score: Number.isFinite(Number(itinerary.score)) ? Math.round(Number(itinerary.score) * 100) : 100 - stops * 10
    });
  }
}

// Builds the Skyscanner deep link for an itinerary. Prefers a booking/pricing
// URL carried by the itinerary; otherwise constructs a stable Skyscanner search
// URL from the route + date. The affiliate marker is appended when configured.
// Exported so the URL shape is directly testable.
export function skyscannerDeepLink(itinerary, route, affiliateId) {
  const base = directBookingUrl(itinerary) || buildSkyscannerSearchUrl(route);
  return appendMarker(base, affiliateId, 'associateid');
}

function directBookingUrl(itinerary) {
  const options = Array.isArray(itinerary.pricingOptions) ? itinerary.pricingOptions : [];
  const url = options[0]?.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

function buildSkyscannerSearchUrl({ from, to, date }) {
  const origin = String(from).toLowerCase();
  const destination = String(to).toLowerCase();
  const day = toYymmdd(date);
  const path = day ? `${origin}/${destination}/${day}` : `${origin}/${destination}`;
  return `https://www.skyscanner.net/transport/flights/${path}/`;
}

// A YYYY-MM-DD(...) date reduces to Skyscanner's yymmdd path segment.
function toYymmdd(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  return match ? `${match[1].slice(2)}${match[2]}${match[3]}` : '';
}

function appendMarker(url, value, param) {
  if (!value) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${param}=${encodeURIComponent(value)}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function describeApiError(payload) {
  const message = Array.isArray(payload.message)
    ? payload.message.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ')
    : payload.message;
  return message || 'request rejected';
}
