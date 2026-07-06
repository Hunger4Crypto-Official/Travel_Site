import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

const DEFAULT_BASE_URL = 'https://booking-com15.p.rapidapi.com';
const DEFAULT_RAPIDAPI_HOST = 'booking-com15.p.rapidapi.com';
const MAX_CARS = 25;
const DEFAULT_RENTAL_DAYS = 3;

// Booking.com car-rental search provider (cars), via RapidAPI (booking-com15).
// Two-step flow mirroring the documented car API:
//   1) resolve the pickup city to lat/lon with cars/searchDestination
//   2) query cars/searchCarRentals with those coordinates for pickup + dropoff.
// Booking's car listings are "from" prices: the headline rate covers the base
// rental but not on-site extras (young-driver / additional-driver fees, optional
// insurance, fuel), so offers are marked estimated:true and rank as indicative.
// One-way rentals are not modelled here: dropoff defaults to the pickup point.
// Destination resolutions are static, so they are cached for the process
// lifetime. Recorded fixture shapes are approximate and need `npm run
// smoke:live` verification against the real API.
// https://rapidapi.com/DataCrawler/api/booking-com15
export class CarRentalProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'car-rental',
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
    return type === 'cars';
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: ['cars'],
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

  // Resolves a free-text pickup city to the { lat, lon } pair searchCarRentals
  // needs. Booking's car searchDestination returns coordinates per entry; we
  // pick the first entry that yields a finite lat/lon. Cached by lowercased city.
  async resolveDestination(city) {
    const query = String(city || '').trim();
    if (!query) return null;
    const cacheKey = query.toLowerCase();
    if (this.destinationCache.has(cacheKey)) return this.destinationCache.get(cacheKey);

    const payload = await fetchJson(`${this.baseUrl}/api/v1/cars/searchDestination?query=${encodeURIComponent(query)}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.headers()
    });

    const entries = Array.isArray(payload?.data) ? payload.data : [];
    let location = null;
    for (const entry of entries) {
      const coords = coordinatesOf(entry);
      if (coords) {
        location = { lat: coords.lat, lon: coords.lon, name: entry.name || entry.city || query };
        break;
      }
    }

    if (location) this.destinationCache.set(cacheKey, location);
    return location;
  }

  async search(type, query = {}) {
    if (type !== 'cars') return [];

    const location = await this.resolveDestination(query.city);
    if (!location) return [];

    const params = new URLSearchParams({
      pick_up_latitude: String(location.lat),
      pick_up_longitude: String(location.lon),
      drop_off_latitude: String(location.lat),
      drop_off_longitude: String(location.lon),
      pick_up_time: '10:00',
      drop_off_time: '10:00',
      currency_code: this.currency
    });
    const pickup = toDate(query.date);
    if (pickup) {
      const dropoff = toDate(query.dropoff) || addDays(pickup, DEFAULT_RENTAL_DAYS);
      params.set('pick_up_date', isoDate(pickup));
      params.set('drop_off_date', isoDate(dropoff));
    }

    const payload = await fetchJson(`${this.baseUrl}/api/v1/cars/searchCarRentals?${params.toString()}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.headers()
    });

    if (payload && payload.status === false) {
      throw new Error(`Car rental error: ${describeApiError(payload)}`);
    }
    const results = Array.isArray(payload?.data?.search_results) ? payload.data.search_results : [];
    return results.slice(0, MAX_CARS)
      .map((record) => this.toOffer(record, location))
      .filter(Boolean);
  }

  toOffer(record, location) {
    const vehicle = record?.vehicle_info || {};
    const supplier = record?.supplier_info || {};
    const pricing = record?.pricing_info || {};
    const name = vehicle.v_name || vehicle.name || null;
    if (!name) return null;

    const total = Number(pricing.price);
    if (!Number.isFinite(total)) return null;
    const currency = (pricing.currency || pricing.base_currency || this.currency).toUpperCase();
    const supplierName = supplier.name || null;

    const pickupInfo = record?.route_info?.pickup || {};
    const pickupLocation = pickupInfo.name || pickupInfo.address || location.name;
    const deepLink = record?.deeplink || record?.url || pricing.deeplink || null;

    return normalizeOffer({
      type: 'cars',
      provider: this.name,
      // Booking's numeric/opaque vehicle ids stay out of dedupe (they are
      // internal); a stable id still falls back to the vehicle + supplier name.
      id: `car-rental-${record.vehicle_id || slug(`${name}-${supplierName || ''}`)}`,
      // "From" rate: base rental only, not an all-in total (on-site extras such
      // as young/additional-driver fees and optional insurance are excluded).
      price: { amount: total, total, currency, estimated: true },
      freshness: 'live',
      title: supplierName ? `${name} (${supplierName})` : name,
      deepLink,
      affiliateId: this.affiliateId,
      details: {
        supplier: supplierName,
        vehicleClass: vehicle.group || vehicle.category || null,
        seats: Number.isFinite(Number(vehicle.seats)) ? Number(vehicle.seats) : null,
        transmission: vehicle.transmission || null,
        pickupLocation
      }
    });
  }
}

// Extracts { lat, lon } from a searchDestination entry, tolerating the several
// coordinate shapes Booking has used (nested coordinates or flat lat/lon).
function coordinatesOf(entry) {
  if (!entry) return null;
  const coords = entry.coordinates || entry;
  const lat = Number(coords.latitude ?? coords.lat);
  const lon = Number(coords.longitude ?? coords.lon ?? coords.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'car';
}

function describeApiError(payload) {
  const message = Array.isArray(payload.message)
    ? payload.message.map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ')
    : payload.message;
  return message || 'request rejected';
}
