// Public-holidays enrichment backed by the Nager.Date public holidays API.
//
//   API:      Nager.Date - Public Holidays v3
//   Base URL: https://date.nager.at/api/v3/PublicHolidays/{year}/{countryCode}
//   Access:   FREE and KEYLESS (no registration, no API key, no auth header).
//
// The curated awesome-scrape-free-apis list is entirely RapidAPI-hosted and
// every entry needs an account and API key, so none of it satisfies the
// no-key constraint. Nager.Date is a well-known, honestly free and keyless
// public API and is the complementary pick alongside the existing Frankfurter
// currency converter (src/utils/currency.js), which it does not duplicate.
//
// ENRICHMENT ONLY. This module provides travel context (which days are public
// holidays in a destination) and MUST NEVER be used for pricing, ranking,
// booking, money movement, or compliance decisions. It only reads and returns
// a small, clearly labeled slice of holiday facts.
//
// Contract:
//   - When `enabled` is false OR no `fetchJson` is provided, every call returns
//     null (a disabled marker). Callers treat null as "no enrichment available"
//     and carry on without inventing data.
//   - Bad input throws an Error with `.statusCode = 400`.
//   - Any upstream failure or malformed response is wrapped into an Error with
//     `.statusCode = 502` and a safe, generic message. Upstream error detail is
//     kept only on `.cause` and never placed in the client-facing message.

const BASE_URL = 'https://date.nager.at/api/v3';
const SOURCE_LABEL = 'Nager.Date public holidays (enrichment only)';
const MIN_YEAR = 1975;
const MAX_YEAR = 2100;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function badGateway(message, cause) {
  const err = new Error(message);
  err.statusCode = 502;
  if (cause) err.cause = cause;
  return err;
}

function normalizeCountryCode(raw) {
  if (typeof raw !== 'string') {
    throw badRequest('countryCode must be a string');
  }
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw badRequest('countryCode must be an ISO 3166-1 alpha-2 code, for example US or FR');
  }
  return code;
}

function normalizeYear(raw) {
  const year = Number(raw);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw badRequest(`year must be an integer between ${MIN_YEAR} and ${MAX_YEAR}`);
  }
  return year;
}

// Reduce one upstream holiday record to a small, clearly labeled shape.
// Returns null for anything that does not look like a usable holiday so the
// caller can filter it out rather than surface junk.
function normalizeHoliday(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.date !== 'string') return null;
  return {
    date: entry.date,
    localName: typeof entry.localName === 'string' ? entry.localName : null,
    name: typeof entry.name === 'string' ? entry.name : entry.date,
    nationwide: entry.global === true,
    types: Array.isArray(entry.types) ? entry.types.slice() : []
  };
}

// Factory. `fetchJson` is injected so tests never touch the network; it must
// share the signature of src/utils/httpClient.js#fetchJson.
export function createPublicHolidays({
  fetchJson = null,
  enabled = false,
  timeoutMs = 5000,
  now = () => Date.now()
} = {}) {
  const client = typeof fetchJson === 'function' ? fetchJson : null;
  const active = enabled === true && client !== null;

  // Fetch and normalize the public holidays for one country and year.
  // Returns null when the enricher is disabled, a normalized result on
  // success, throws a 400-style Error on bad input and a 502-style Error on
  // any upstream problem.
  async function holidays(countryCode, year) {
    if (!active) return null;

    const code = normalizeCountryCode(countryCode);
    const resolvedYear = normalizeYear(year);

    let payload;
    try {
      payload = await client(`${BASE_URL}/PublicHolidays/${resolvedYear}/${code}`, {
        timeoutMs,
        headers: { accept: 'application/json' }
      });
    } catch (err) {
      throw badGateway('Public holidays are unavailable right now. Please try again later.', err);
    }

    if (!Array.isArray(payload)) {
      throw badGateway('Public holidays response was malformed.');
    }

    const list = [];
    for (const entry of payload) {
      const normalized = normalizeHoliday(entry);
      if (normalized) list.push(normalized);
    }

    return {
      source: SOURCE_LABEL,
      countryCode: code,
      year: resolvedYear,
      count: list.length,
      holidays: list,
      fetchedAt: new Date(now()).toISOString()
    };
  }

  return {
    enabled: active,
    holidays
  };
}
