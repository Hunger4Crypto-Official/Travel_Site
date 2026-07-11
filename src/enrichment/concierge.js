// Concierge enrichment composer for one in-trip destination briefing.
//
// Stitches four independent enrichment sources into a single response:
//
//   weather  - geocoding plus a short forecast
//   places   - nearby points of interest
//   guide    - a destination guide teaser
//   holidays - public holidays for the destination country
//
// Every source module arrives ALREADY CONSTRUCTED via the factory options and
// this module never imports any of them. Weather is the backbone because it
// provides geocoding; the other three are optional garnish.
//
// ENRICHMENT ONLY. This module provides travel context and MUST NEVER be used
// for pricing, ranking, booking, money movement, or compliance decisions. It
// only composes small, clearly labeled slices of destination facts.
//
// Contract:
//   - When no enabled weather module is injected, `enabled` is false and every
//     lookup returns null (a disabled marker). Callers treat null as "no
//     enrichment available" and carry on without inventing data.
//   - A geocode failure propagates untouched so the router can map its
//     `.statusCode`; a geocode miss throws an Error with `.statusCode = 404`.
//   - The four sections are fetched in parallel and settle independently: a
//     single failed source must never sink the briefing. Each section reports
//     one of the statuses 'ok', 'empty', 'unavailable' or 'disabled'.

const NOT_FOUND_MESSAGE = 'No destination matched that name. Try a nearby major city.';
const NO_COUNTRY_MESSAGE = 'No country code is known for this destination.';
const SOURCE_DOWN_MESSAGE = 'This source is unavailable right now.';

const WEATHER_ATTRIBUTION = 'Weather by Open-Meteo.com';
const PLACES_ATTRIBUTION_FALLBACK = 'Map data (c) OpenStreetMap contributors (ODbL 1.0)';
const GUIDE_ATTRIBUTION_FALLBACK = 'Guide text from Wikivoyage, CC BY-SA 4.0';
const HOLIDAYS_ATTRIBUTION = 'Public holidays from Nager.Date';

function notFound(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

// A section the composer never attempted because its module is absent or
// switched off.
function disabledSection() {
  return { status: 'disabled', data: null };
}

// Reduce one Promise.allSettled outcome to a section. A fulfilled non-null
// value is usable data, a fulfilled null is that module's own disabled or
// empty marker, and a rejection becomes 'unavailable' with a safe message.
function sectionFromOutcome(outcome) {
  if (outcome.status === 'fulfilled') {
    if (outcome.value === null) return { status: 'empty', data: null };
    return { status: 'ok', data: outcome.value };
  }
  const reason = outcome.reason;
  const message = reason && typeof reason.message === 'string' && reason.message.length > 0
    ? reason.message
    : SOURCE_DOWN_MESSAGE;
  return { status: 'unavailable', data: null, message };
}

// Factory. The four source modules are injected so tests never touch the
// network; each must honor the contracts documented in its own module.
export function createConcierge({
  weather = null,
  places = null,
  guides = null,
  holidays = null,
  now = () => Date.now()
} = {}) {
  const active = Boolean(weather && weather.enabled === true);

  // Compose the briefing for one destination. Returns null when the composer
  // is disabled, throws a 404-style Error when nothing matches the name, and
  // otherwise always returns a briefing even when garnish sources fail.
  async function lookup(city, { category = 'see' } = {}) {
    if (!active) return null;

    // Geocode errors propagate untouched; the router maps their .statusCode.
    const geo = await weather.geocode(city);
    if (geo === null) {
      throw notFound(NOT_FOUND_MESSAGE);
    }

    const year = new Date(now()).getUTCFullYear();

    const sections = {
      weather: null,
      places: disabledSection(),
      guide: disabledSection(),
      holidays: disabledSection()
    };

    // Kick off every attempted source before awaiting anything so the whole
    // fan-out runs in parallel.
    const attempts = [
      { key: 'weather', promise: weather.forecast(geo.latitude, geo.longitude) }
    ];
    if (places && places.enabled === true) {
      attempts.push({
        key: 'places',
        promise: places.nearby(geo.latitude, geo.longitude, { category })
      });
    }
    if (guides && guides.enabled === true) {
      attempts.push({ key: 'guide', promise: guides.guide(geo.name) });
    }
    if (holidays && holidays.enabled === true) {
      if (typeof geo.countryCode === 'string' && geo.countryCode.length > 0) {
        attempts.push({ key: 'holidays', promise: holidays.holidays(geo.countryCode, year) });
      } else {
        // The module is willing but the geocoder gave us no country to ask
        // about, so the section is unavailable rather than disabled.
        sections.holidays = { status: 'unavailable', data: null, message: NO_COUNTRY_MESSAGE };
      }
    }

    // allSettled, never all: a single failed source must not sink the briefing.
    const outcomes = await Promise.allSettled(attempts.map((attempt) => attempt.promise));
    for (let i = 0; i < attempts.length; i += 1) {
      sections[attempts[i].key] = sectionFromOutcome(outcomes[i]);
    }

    // Credit only the sources that actually contributed data, in fixed order.
    const attribution = [];
    if (sections.weather.status === 'ok') {
      attribution.push(WEATHER_ATTRIBUTION);
    }
    if (sections.places.status === 'ok') {
      attribution.push(typeof sections.places.data.attribution === 'string'
        ? sections.places.data.attribution
        : PLACES_ATTRIBUTION_FALLBACK);
    }
    if (sections.guide.status === 'ok') {
      attribution.push(typeof sections.guide.data.attribution === 'string'
        ? sections.guide.data.attribution
        : GUIDE_ATTRIBUTION_FALLBACK);
    }
    if (sections.holidays.status === 'ok') {
      attribution.push(HOLIDAYS_ATTRIBUTION);
    }

    return {
      destination: {
        query: city,
        name: geo.name,
        country: geo.country,
        countryCode: geo.countryCode,
        latitude: geo.latitude,
        longitude: geo.longitude,
        timezone: geo.timezone
      },
      sections,
      attribution,
      fetchedAt: new Date(now()).toISOString()
    };
  }

  return {
    enabled: active,
    lookup
  };
}
