import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

// Community ADS-B trackers (adsb.lol, airplanes.live, adsb.fi) expose the same
// readsb/re-api aircraft JSON shape under /v2/icao/<hex> and require no API key.
// They serve as real, no-credentials fallbacks alongside OpenSky for the
// `tracking` vertical.
export class AdsbProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'adsb',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    if (!options.baseUrl) {
      throw new Error('AdsbProvider requires a baseUrl');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
  }

  supports(type) {
    return type === 'tracking';
  }

  status() {
    return {
      provider: this.name,
      enabled: this.enabled,
      ready: this.ready,
      supports: ['tracking'],
      baseUrl: this.baseUrl
    };
  }

  async search(type, query = {}) {
    if (type !== 'tracking') return [];

    const icao24 = String(query.icao24 || '').trim().toLowerCase();
    const url = `${this.baseUrl}/v2/icao/${encodeURIComponent(icao24)}`;
    const payload = await fetchJson(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: { accept: 'application/json' }
    });

    const aircraft = Array.isArray(payload?.ac) ? payload.ac : [];
    return aircraft.map((ac) => this.toOffer(ac, payload.now));
  }

  toOffer(ac, nowMs) {
    const callsign = typeof ac.flight === 'string' ? ac.flight.trim() : null;
    const seenSeconds = Number(ac.seen);
    const observedAt = Number.isFinite(nowMs) && Number.isFinite(seenSeconds)
      ? new Date(nowMs - seenSeconds * 1000).toISOString()
      : null;
    return normalizeOffer({
      type: 'tracking',
      provider: this.name,
      id: `tracking-${ac.hex || callsign || 'unknown'}`,
      price: 0,
      title: `Live position for ${callsign || ac.hex || 'aircraft'}`,
      affiliateId: this.affiliateId,
      details: {
        icao24: typeof ac.hex === 'string' ? ac.hex.toLowerCase() : null,
        callsign: callsign || null,
        registration: ac.r ?? null,
        aircraftType: ac.t ?? null,
        latitude: numberOrNull(ac.lat),
        longitude: numberOrNull(ac.lon),
        baroAltitudeFt: altitude(ac.alt_baro),
        geoAltitudeFt: altitude(ac.alt_geom),
        groundSpeedKt: numberOrNull(ac.gs),
        trueTrackDeg: numberOrNull(ac.track),
        verticalRateFpm: numberOrNull(ac.baro_rate),
        squawk: ac.squawk ?? null,
        emergency: ac.emergency ?? null,
        observedAt,
        source: this.name
      }
    });
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function altitude(value) {
  if (value === 'ground') return 'ground';
  return numberOrNull(value);
}
