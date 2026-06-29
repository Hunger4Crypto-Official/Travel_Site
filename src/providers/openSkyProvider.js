import { BaseProvider } from './baseProvider.js';
import { normalizeOffer } from '../engine/normalizers.js';
import { fetchJson } from '../utils/httpClient.js';

const DEFAULT_BASE_URL = 'https://opensky-network.org/api';

// Index of the OpenSky state-vector array, per the documented OpenSky REST API.
// https://openskynetwork.github.io/opensky-api/rest.html#all-state-vectors
const STATE = {
  icao24: 0,
  callsign: 1,
  originCountry: 2,
  timePosition: 3,
  lastContact: 4,
  longitude: 5,
  latitude: 6,
  baroAltitude: 7,
  onGround: 8,
  velocity: 9,
  trueTrack: 10,
  verticalRate: 11,
  geoAltitude: 13,
  squawk: 14,
  positionSource: 16
};

// Real live flight tracking via the public OpenSky Network REST API.
// Anonymous access needs no API key (rate limited); optional basic-auth
// credentials raise the rate limit. Network egress to opensky-network.org
// must be permitted by the environment for live data to be returned.
export class OpenSkyProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      name: options.name || 'opensky-network',
      enabled: options.enabled ?? true,
      affiliateId: options.affiliateId || null,
      timeoutMs: options.timeoutMs
    });
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.username = options.username || null;
    this.password = options.password || null;
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
      authenticated: Boolean(this.username && this.password)
    };
  }

  async search(type, query = {}) {
    if (type !== 'tracking') return [];

    const icao24 = String(query.icao24 || '').trim().toLowerCase();
    const url = `${this.baseUrl}/states/all?icao24=${encodeURIComponent(icao24)}`;
    const payload = await fetchJson(url, {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      headers: this.buildHeaders()
    });

    const states = Array.isArray(payload?.states) ? payload.states : [];
    return states.map((state) => this.toOffer(state, payload.time));
  }

  buildHeaders() {
    const headers = { accept: 'application/json' };
    if (this.username && this.password) {
      const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers.authorization = `Basic ${token}`;
    }
    return headers;
  }

  toOffer(state, snapshotTime) {
    const callsign = typeof state[STATE.callsign] === 'string' ? state[STATE.callsign].trim() : null;
    const lastContact = state[STATE.lastContact];
    return normalizeOffer({
      type: 'tracking',
      provider: this.name,
      id: `tracking-${state[STATE.icao24]}`,
      price: 0,
      title: `Live position for ${callsign || state[STATE.icao24]}`,
      affiliateId: this.affiliateId,
      details: {
        icao24: state[STATE.icao24],
        callsign: callsign || null,
        originCountry: state[STATE.originCountry] ?? null,
        onGround: Boolean(state[STATE.onGround]),
        longitude: state[STATE.longitude] ?? null,
        latitude: state[STATE.latitude] ?? null,
        baroAltitudeM: state[STATE.baroAltitude] ?? null,
        geoAltitudeM: state[STATE.geoAltitude] ?? null,
        velocityMs: state[STATE.velocity] ?? null,
        trueTrackDeg: state[STATE.trueTrack] ?? null,
        verticalRateMs: state[STATE.verticalRate] ?? null,
        squawk: state[STATE.squawk] ?? null,
        lastContact: Number.isFinite(lastContact) ? new Date(lastContact * 1000).toISOString() : null,
        snapshotTime: Number.isFinite(snapshotTime) ? new Date(snapshotTime * 1000).toISOString() : null,
        source: 'opensky-network'
      }
    });
  }
}
