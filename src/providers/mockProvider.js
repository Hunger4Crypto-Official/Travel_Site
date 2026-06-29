import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';

// Demo pricing for the verticals that still require paid provider APIs.
// `airports` and `tracking` are served by real no-key providers, so the demo
// provider no longer fabricates data for them.
const defaultOffsets = {
  flights: [312, 344, 389],
  hotels: [129, 151, 176],
  cars: [48, 57, 71]
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
