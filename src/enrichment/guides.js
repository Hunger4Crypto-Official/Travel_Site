// Destination-guide enrichment backed by the Wikivoyage MediaWiki API.
//
//   API:      MediaWiki Action API (action=query, prop=extracts)
//   Base URL: https://en.wikivoyage.org/w/api.php
//   Access:   FREE and KEYLESS (no registration, no API key, no auth header).
//
// Wikivoyage guide text is licensed CC BY-SA 4.0, so every result returned by
// this module MUST always carry attribution; the `attribution` field below is
// part of the contract and callers must surface it alongside the summary.
//
// ENRICHMENT ONLY. This module provides travel context (a short destination
// guide intro) and MUST NEVER be used for pricing, ranking, booking, money
// movement, or compliance decisions. It only reads and returns a small,
// clearly labeled slice of guide text.
//
// Contract:
//   - When `enabled` is false OR no `fetchJson` is provided, every call returns
//     null (a disabled marker). Callers treat null as "no enrichment available"
//     and carry on without inventing data.
//   - Bad input throws an Error with `.statusCode = 400`.
//   - Any upstream failure or malformed response is wrapped into an Error with
//     `.statusCode = 502` and a safe, generic message. Upstream error detail is
//     kept only on `.cause` and never placed in the client-facing message.
//   - A destination that simply has no guide page (or an empty extract) is not
//     an error: guide() returns null and the caller carries on.

const BASE_URL = 'https://en.wikivoyage.org';
const SOURCE_LABEL = 'Wikivoyage (enrichment only)';
const ATTRIBUTION = 'Guide text from Wikivoyage, CC BY-SA 4.0';
const MAX_DESTINATION_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 1200;
const ELLIPSIS = '…';

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

function normalizeDestination(raw) {
  if (typeof raw !== 'string') {
    throw badRequest('destination must be a non-empty string of at most 120 characters');
  }
  const destination = raw.trim();
  if (destination.length < 1 || destination.length > MAX_DESTINATION_LENGTH) {
    throw badRequest('destination must be a non-empty string of at most 120 characters');
  }
  return destination;
}

// Cap the summary at MAX_SUMMARY_LENGTH characters. Long extracts are cut at
// the last space inside the limit (hard cut when there is no space at all)
// and marked with a single horizontal ellipsis character.
function truncateSummary(extract) {
  if (extract.length <= MAX_SUMMARY_LENGTH) return extract;
  const head = extract.slice(0, MAX_SUMMARY_LENGTH);
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace === -1) return head + ELLIPSIS;
  return head.slice(0, lastSpace) + ELLIPSIS;
}

// Factory. `fetchJson` is injected so tests never touch the network; it must
// share the signature of src/utils/httpClient.js#fetchJson.
export function createGuides({
  fetchJson = null,
  enabled = false,
  timeoutMs = 5000,
  now = () => Date.now()
} = {}) {
  const client = typeof fetchJson === 'function' ? fetchJson : null;
  const active = enabled === true && client !== null;

  // Fetch the intro of the Wikivoyage guide page for one destination.
  // Returns null when the enricher is disabled or no guide page exists,
  // a normalized result on success, throws a 400-style Error on bad input
  // and a 502-style Error on any upstream problem.
  async function guide(destination) {
    if (!active) return null;

    const name = normalizeDestination(destination);

    let payload;
    try {
      payload = await client(
        `${BASE_URL}/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(name)}`,
        {
          timeoutMs,
          headers: { accept: 'application/json' }
        }
      );
    } catch (err) {
      throw badGateway('Destination guides are unavailable right now. Please try again later.', err);
    }

    if (!payload || typeof payload !== 'object') {
      throw badGateway('Destination guide response was malformed.');
    }
    if (!payload.query || typeof payload.query !== 'object') {
      throw badGateway('Destination guide response was malformed.');
    }
    if (!Array.isArray(payload.query.pages)) {
      throw badGateway('Destination guide response was malformed.');
    }

    // No guide is not an error: an absent, missing, or empty page maps to null.
    const page = payload.query.pages[0];
    if (!page || typeof page !== 'object') return null;
    if (page.missing) return null;
    if (typeof page.extract !== 'string') return null;

    const extract = page.extract.trim();
    if (extract === '') return null;

    const title = typeof page.title === 'string' && page.title.trim() !== ''
      ? page.title
      : name;

    return {
      source: SOURCE_LABEL,
      attribution: ATTRIBUTION,
      title,
      summary: truncateSummary(extract),
      url: `${BASE_URL}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      fetchedAt: new Date(now()).toISOString()
    };
  }

  return {
    enabled: active,
    guide
  };
}
