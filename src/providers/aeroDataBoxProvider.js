import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

const DEFAULT_BASE_URL = 'https://aerodatabox.p.rapidapi.com';
const DEFAULT_RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';

// AeroDataBox airport reference provider (airports), via RapidAPI.
// Enriches the offline dataset with live airport detail when a RapidAPI key is
// configured. https://rapidapi.com/aedbx-aedbx/api/aerodatabox
export class AeroDataBoxProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'aerodatabox',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.apiKey = options.apiKey || null;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.rapidApiHost = options.rapidApiHost || DEFAULT_RAPIDAPI_HOST;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  get ready() {
    return this.enabled && Boolean(this.apiKey);
  }

  supports(type) {
    return type === 'airports';
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: ['airports'],
      configured: Boolean(this.apiKey)
    };
  }

  async search(type, query = {}) {
    if (type !== 'airports') return [];

    const code = String(query.code || '').trim().toUpperCase();
    if (!/^[A-Z]{3,4}$/.test(code)) return [];
    const codeType = code.length === 4 ? 'icao' : 'iata';

    const payload = await fetchJson(`${this.baseUrl}/airports/${codeType}/${encodeURIComponent(code)}`, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: {
        'X-RapidAPI-Key': this.apiKey,
        'X-RapidAPI-Host': this.rapidApiHost,
        accept: 'application/json'
      }
    });

    if (!payload || !(payload.iata || payload.icao)) return [];
    return [this.toOffer(payload)];
  }

  toOffer(airport) {
    return normalizeOffer({
      type: 'airports',
      provider: this.name,
      id: `airport-${airport.iata || airport.icao}`,
      price: 0,
      title: `${airport.fullName || airport.name} (${airport.iata || '?'}/${airport.icao || '?'})`,
      affiliateId: this.affiliateId,
      details: {
        iata: airport.iata ?? null,
        icao: airport.icao ?? null,
        name: airport.fullName || airport.name || null,
        city: airport.municipalityName ?? null,
        country: airport.countryCode ?? airport.country?.code ?? null,
        location: airport.location
          ? { lat: airport.location.lat ?? null, lon: airport.location.lon ?? null }
          : null,
        timezone: airport.timeZone ?? null,
        elevationFt: airport.elevation?.feet ?? null
      }
    });
  }
}
