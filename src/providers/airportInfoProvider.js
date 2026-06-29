import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { airports } from './data/airports.js';

// Real airport reference data from a bundled public IATA/ICAO dataset.
// Requires no API key or network access, so the `airports` vertical returns
// genuine information instead of a placeholder.
export class AirportInfoProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'iata-icao-reference',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });

    this.index = new Map();
    for (const airport of options.dataset || airports) {
      if (airport.iata) this.index.set(airport.iata.toUpperCase(), airport);
      if (airport.icao) this.index.set(airport.icao.toUpperCase(), airport);
    }
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
      airports: this.index.size
    };
  }

  async search(type, query = {}) {
    if (type !== 'airports') return [];

    const code = String(query.code || '').trim().toUpperCase();
    const airport = this.index.get(code);
    if (!airport) return [];

    return [normalizeOffer({
      type,
      provider: this.name,
      id: `airport-${airport.iata || airport.icao}`,
      price: 0,
      title: `${airport.name} (${airport.iata}/${airport.icao})`,
      affiliateId: this.affiliateId,
      details: {
        iata: airport.iata,
        icao: airport.icao,
        name: airport.name,
        city: airport.city,
        country: airport.country,
        location: { lat: airport.lat, lon: airport.lon },
        timezone: airport.tz
      }
    })];
  }
}
