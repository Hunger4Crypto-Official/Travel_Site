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
    // Verticals the demo must NOT serve because a real provider covers them.
    // Keeps fake placeholder prices out of genuine lowest-price comparisons.
    this.excludeTypes = new Set(options.excludeTypes || []);
  }

  supportedTypes() {
    return Object.keys(this.offsets).filter((type) => !this.excludeTypes.has(type));
  }

  supports(type) {
    return this.supportedTypes().includes(type);
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: this.supportedTypes()
    };
  }

  async search(type, query = {}) {
    if (this.excludeTypes.has(type)) return [];
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
