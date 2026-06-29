import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';

const defaultOffsets = {
  flights: [312, 344, 389],
  hotels: [129, 151, 176],
  cars: [48, 57, 71],
  airports: [0],
  tracking: [0]
};

export class MockProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'mock-provider',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.offsets = options.offsets || defaultOffsets;
  }

  supports(type) {
    return Object.keys(this.offsets).includes(type);
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: Object.keys(this.offsets)
    };
  }

  async search(type, query = {}) {
    if (type === 'airports') {
      return [normalizeOffer({ type, provider: this.name, id: `airport-${query.code}`, price: 0, title: `Airport info for ${query.code}`, affiliateId: this.affiliateId, details: query })];
    }
    if (type === 'tracking') {
      return [normalizeOffer({ type, provider: this.name, id: `tracking-${query.icao24}`, price: 0, title: `Live flight tracking for ${query.icao24}`, affiliateId: this.affiliateId, details: { ...query, note: 'Mock tracking data until a live aviation API key is connected.' } })];
    }
    return (this.offsets[type] || []).map((price, index) => normalizeOffer({
      type,
      provider: this.name,
      id: `${this.name}-${type}-${index + 1}`,
      price,
      title: `${type.slice(0, -1)} option ${index + 1}`,
      deepLink: null,
      affiliateId: this.affiliateId,
      details: { ...query, mock: true },
      score: 100 - index
    }));
  }
}
