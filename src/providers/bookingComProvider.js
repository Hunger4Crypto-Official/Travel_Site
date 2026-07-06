import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

const DEFAULT_BASE_URL = 'https://booking-com15.p.rapidapi.com';
const DEFAULT_RAPIDAPI_HOST = 'booking-com15.p.rapidapi.com';
const MAX_HOTELS = 25;

// Booking.com hotel search provider (hotels), via RapidAPI (booking-com15).
// Two-step flow: resolve the city to a Booking dest_id with searchDestination,
// then query searchHotels. The all-in total is grossPrice plus any excluded
// charges Booking reports separately, so the comparison stays honest.
// Destination resolutions are static, so they are cached for the process
// lifetime. https://rapidapi.com/DataCrawler/api/booking-com15
export class BookingComProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'booking-com',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.apiKey = options.apiKey || null;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.rapidApiHost = options.rapidApiHost || DEFAULT_RAPIDAPI_HOST;
    this.currency = (options.currency || 'USD').toUpperCase();
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.destinationCache = new Map();
  }

  get ready() {
    return this.enabled && Boolean(this.apiKey);
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

  // Resolves a free-text city to Booking's { destId, searchType } pair.
  // Prefers a city-type destination so hotel search covers the whole city.
  async resolveDestination(city) {
    const query = String(city || '').trim();
    if (!query) return null;
    const cacheKey = query.toLowerCase();
    if (this.destinationCache.has(cacheKey)) return this.destinationCache.get(cacheKey);

    const payload = await fetchJson(`${this.baseUrl}/api/v1/hotels/searchDestination?query=${encodeURIComponent(query)}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.headers()
    });

    const entries = Array.isArray(payload?.data) ? payload.data : [];
    const cityEntry = entries.find((e) => String(e.search_type || e.dest_type || '').toLowerCase() === 'city');
    const chosen = cityEntry || entries[0];
    const destination = chosen?.dest_id
      ? { destId: String(chosen.dest_id), searchType: String(chosen.search_type || chosen.dest_type || 'CITY').toUpperCase(), cityName: chosen.city_name || query }
      : null;

    if (destination) this.destinationCache.set(cacheKey, destination);
    return destination;
  }

  async search(type, query = {}) {
    if (type !== 'hotels') return [];

    const destination = await this.resolveDestination(query.city);
    if (!destination) return [];

    const params = new URLSearchParams({
      dest_id: destination.destId,
      search_type: destination.searchType,
      adults: String(clampInt(query.adults, 1, 8, 1)),
      room_qty: String(clampInt(query.rooms, 1, 8, 1)),
      page_number: '1',
      currency_code: this.currency,
      units: 'metric',
      temperature_unit: 'c',
      languagecode: 'en-us'
    });
    if (query.checkin) params.set('arrival_date', String(query.checkin));
    if (query.checkout) params.set('departure_date', String(query.checkout));

    const payload = await fetchJson(`${this.baseUrl}/api/v1/hotels/searchHotels?${params.toString()}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.headers()
    });

    if (payload && payload.status === false) {
      throw new Error(`Booking.com error: ${describeApiError(payload)}`);
    }
    const hotels = Array.isArray(payload?.data?.hotels) ? payload.data.hotels : [];
    return hotels.slice(0, MAX_HOTELS)
      .map((hotel) => this.toOffer(hotel, destination, query))
      .filter(Boolean);
  }

  toOffer(hotel, destination, query = {}) {
    const property = hotel?.property;
    if (!property?.name) return null;
    const breakdown = property.priceBreakdown || {};
    const gross = Number(breakdown.grossPrice?.value);
    if (!Number.isFinite(gross)) return null;
    const excluded = Number(breakdown.excludedPrice?.value);
    const fees = Number.isFinite(excluded) && excluded > 0 ? excluded : null;
    const currency = (breakdown.grossPrice?.currency || this.currency).toUpperCase();

    return normalizeOffer({
      type: 'hotels',
      provider: this.name,
      id: `booking-com-${hotel.hotel_id || property.id}`,
      // All-in = gross price + charges Booking lists as excluded from it.
      price: { amount: gross, base: gross, fees, total: gross + (fees || 0), currency, estimated: false },
      freshness: 'live',
      title: property.name,
      deepLink: bookingDeepLink(property, {
        checkin: query.checkin ?? property.checkinDate,
        checkout: query.checkout ?? property.checkoutDate
      }, this.affiliateId),
      affiliateId: this.affiliateId,
      details: {
        // Deliberately NOT `code`: Booking's numeric hotel ids are internal and
        // could collide with another provider's ids in dedupe; the same hotel
        // still collapses across providers via the name+city canonical key.
        hotelId: hotel.hotel_id ?? property.id ?? null,
        // destination.cityName always resolves (it falls back to the query), so
        // this is never null in practice.
        city: property.wishlistName || destination.cityName,
        reviewScore: property.reviewScore ?? null,
        reviewCount: property.reviewCount ?? null,
        stars: property.accuratePropertyClass ?? property.propertyClass ?? null,
        checkin: property.checkinDate ?? null,
        checkout: property.checkoutDate ?? null,
        location: Number.isFinite(property.latitude) && Number.isFinite(property.longitude)
          ? { lat: property.latitude, lon: property.longitude }
          : null
      },
      score: hotelScore(property)
    });
  }
}

// Builds the Booking.com deep link for a property. Prefers the property's own
// URL when the API returns one; otherwise constructs a Booking search URL for
// the property name + stay dates. The affiliate aid is appended when set.
// Exported so the URL shape is directly testable.
export function bookingDeepLink(property, stay, affiliateId) {
  const base = propertyUrl(property) || buildBookingSearchUrl(property, stay);
  return appendMarker(base, affiliateId, 'aid');
}

function propertyUrl(property) {
  const url = property.url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

function buildBookingSearchUrl(property, stay) {
  const params = new URLSearchParams({ ss: property.name });
  if (stay.checkin) params.set('checkin', String(stay.checkin));
  if (stay.checkout) params.set('checkout', String(stay.checkout));
  return `https://www.booking.com/searchresults.html?${params.toString()}`;
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

// Booking review scores are 0-10; property class (stars) is the fallback.
function hotelScore(property) {
  const review = Number(property.reviewScore);
  if (Number.isFinite(review) && review > 0) return Math.round(review * 10);
  const stars = Number(property.accuratePropertyClass ?? property.propertyClass);
  return Number.isFinite(stars) && stars > 0 ? stars * 20 : null;
}

function describeApiError(payload) {
  const message = Array.isArray(payload.message)
    ? payload.message.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ')
    : payload.message;
  return message || 'request rejected';
}
