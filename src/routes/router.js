import { success, error } from '../utils/formatter.js';
import { authenticate, createRequestContext, responseHeaders } from '../utils/http.js';

const SOURCE = 'the-travel-club';

const routeMap = new Map([
  ['/flights/search', 'flights'],
  ['/hotels/search', 'hotels'],
  ['/cars/search', 'cars'],
  ['/airport/info', 'airports'],
  ['/flights/live', 'tracking'],
  ['/v1/flights/search', 'flights'],
  ['/v1/hotels/search', 'hotels'],
  ['/v1/cars/search', 'cars'],
  ['/v1/airport/info', 'airports'],
  ['/v1/flights/live', 'tracking']
]);

// Versioned routes advertised in discovery responses (the unversioned aliases
// stay available but are not promoted).
const advertisedRoutes = [...[...routeMap.keys()].filter((path) => path.startsWith('/v1/')), '/v1/flights/calendar', '/v1/prices/history', '/v1/trust'];
const openapiPaths = new Set(['/openapi.yaml', '/openapi.json', '/v1/openapi.yaml']);
const protectedPaths = new Set(['/ready', '/metrics']);

// The API default CSP is default-src 'none' (right for JSON). The web pages are
// self-contained single files, so they need inline style/script and same-origin
// fetch, while still forbidding framing, external sources, and form exfiltration.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export async function handleRequest(req, res, { engine, brand, logger, config, openapiSpec = null, pages = {} }) {
  const context = createRequestContext(req);
  setHeaders(res, responseHeaders({ requestId: context.requestId, origin: req.headers.origin, allowedOrigins: config.allowedOrigins }));

  const brandMeta = { name: brand.name, acronym: brand.acronym, tagline: brand.tagline };
  const ok = (statusCode, data, extraMeta = {}) => sendJson(
    res, statusCode,
    success(SOURCE, data, { brand: brandMeta, requestId: context.requestId, version: brand.apiVersion, ...extraMeta }),
    context, logger
  );
  const fail = (statusCode, message, details) => sendJson(
    res, statusCode,
    error(message, statusCode, details, { requestId: context.requestId, version: brand.apiVersion }),
    context, logger
  );

  if (req.method === 'OPTIONS') return sendJson(res, 204, null, context, logger);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return fail(405, 'Method not allowed', { allow: ['GET', 'OPTIONS'] });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  // Normalize a single trailing slash (e.g. /v1/flights/search/) so a common
  // copy-paste typo resolves to the real route instead of a 404.
  const pathname = url.pathname.length > 1 && url.pathname.endsWith('/')
    ? url.pathname.slice(0, -1)
    : url.pathname;
  logger?.info('Request started', { requestId: context.requestId, method: req.method, path: pathname });

  // Discovery: browsers get the web app at the root, API clients get the JSON
  // index; same URL is negotiated by the Accept header.
  if (pathname === '/' || pathname === '') {
    if (pages.app && wantsHtml(req)) {
      res.setHeader('cache-control', 'public, max-age=60');
      res.setHeader('content-security-policy', PAGE_CSP);
      return sendText(res, 200, pages.app, 'text/html; charset=utf-8', context, logger);
    }
    res.setHeader('cache-control', 'public, max-age=300');
    return ok(200, serviceIndex(brand));
  }

  if (pathname === '/app' || pathname === '/admin') {
    const page = pathname === '/app' ? pages.app : pages.admin;
    if (!page) return fail(404, 'This page is not available on this deployment', { path: pathname });
    res.setHeader('cache-control', 'public, max-age=60');
    res.setHeader('content-security-policy', PAGE_CSP);
    return sendText(res, 200, page, 'text/html; charset=utf-8', context, logger);
  }

  if (pathname === '/health') {
    return ok(200, { ok: true, brand: brand.name });
  }

  // The trust manifest is deliberately public: published commitments are only
  // worth something when anyone can read them.
  if (pathname === '/v1/trust') {
    res.setHeader('cache-control', 'public, max-age=300');
    return ok(200, trustManifest(brand));
  }

  if (openapiPaths.has(pathname)) {
    if (!openapiSpec) return fail(404, 'OpenAPI specification is not available', { path: pathname });
    res.setHeader('cache-control', 'public, max-age=300');
    return sendText(res, 200, openapiSpec, 'application/yaml', context, logger);
  }

  const authConfig = protectedPaths.has(pathname)
    ? { ...config, requireApiKey: config.requireApiKey || config.apiKeys.length > 0 }
    : config;
  const auth = authenticate(req, authConfig);
  if ((authConfig.requireApiKey || protectedPaths.has(pathname)) && !auth.ok) {
    return fail(auth.statusCode, auth.message);
  }

  if (pathname === '/ready') {
    const readiness = engine.readiness();
    return ok(readiness.ok ? 200 : 503, readiness);
  }

  if (pathname === '/metrics') {
    return ok(200, engine.metricsSnapshot());
  }

  try {
    const query = Object.fromEntries(url.searchParams.entries());

    if (pathname === '/v1/prices/history') {
      return ok(200, engine.priceHistorySnapshot(query.type, query), { principal: auth.principal });
    }

    // Rate-limit per authenticated principal when available, else per client IP.
    const clientKey = auth.principal && auth.principal !== 'anonymous' ? auth.principal : clientIp(req);

    if (pathname === '/v1/flights/calendar') {
      const calendar = await engine.flexibleSearch('flights', query, { clientKey }, { flexDays: query.flex });
      return ok(200, calendar, { principal: auth.principal });
    }

    const type = routeMap.get(pathname);
    if (!type) {
      return fail(404, 'Route not found', { path: pathname, availableRoutes: advertisedRoutes });
    }

    const data = await engine.search(type, query, { clientKey });
    return ok(200, data, { principal: auth.principal });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    const publicMessage = statusCode >= 500 ? 'Unexpected error' : err.message;
    // On 5xx only expose details that were explicitly marked public; never the
    // raw internal err.details, which may carry implementation specifics.
    const publicDetails = statusCode >= 500 ? err.publicDetails : (err.publicDetails || err.details);
    if (statusCode === 429 && err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    logger?.warn('Request failed', { requestId: context.requestId, statusCode, error: err.message, details: err.details });
    return fail(statusCode, publicMessage, publicDetails);
  }
}

function serviceIndex(brand, now = Date.now()) {
  // Example dates are always in the near future so a copy-paste of the discovery
  // response is a valid request (past dates are rejected by validation).
  const isoDate = (daysAhead) => new Date(now + daysAhead * 86400000).toISOString().slice(0, 10);
  const depart = isoDate(30);
  const checkin = isoDate(30);
  const checkout = isoDate(33);
  const carDate = isoDate(30);
  return {
    service: brand.name,
    acronym: brand.acronym,
    tagline: brand.tagline,
    version: brand.apiVersion,
    documentation: '/openapi.yaml',
    endpoints: {
      app: '/app',
      admin: '/admin',
      health: '/health',
      readiness: '/ready',
      metrics: '/metrics',
      trust: '/v1/trust',
      flights: `/v1/flights/search?from=LAX&to=JFK&date=${depart}`,
      flightsCalendar: `/v1/flights/calendar?from=LAX&to=JFK&date=${depart}&flex=3`,
      hotels: `/v1/hotels/search?city=Las%20Vegas&checkin=${checkin}&checkout=${checkout}`,
      cars: `/v1/cars/search?city=Miami&date=${carDate}`,
      priceHistory: '/v1/prices/history?type=flights&from=LAX&to=JFK',
      airport: '/v1/airport/info?code=LAX',
      tracking: '/v1/flights/live?icao24=4b1814'
    }
  };
}

// Machine-readable trust commitments, each tied to the API mechanism that
// enforces it. Derived from docs/research/competitive-landscape.md: trusted
// travel brands convert hidden costs into explicit, published commitments.
function trustManifest(brand) {
  return {
    service: brand.name,
    manifesto: 'Compare honestly or say why we cannot.',
    commitments: [
      {
        id: 'all-in-pricing',
        promise: 'Every price is an all-in total (base + taxes + fees), or it is explicitly marked as an estimate.',
        mechanism: 'offer.price.total with offer.price.estimated; response-level priceComparable never overclaims.'
      },
      {
        id: 'no-fake-urgency',
        promise: 'No countdown timers, scarcity counters, or social-proof numbers. Ever.',
        mechanism: 'No such fields exist anywhere in the API contract.'
      },
      {
        id: 'no-paid-ranking',
        promise: 'Ranking is cheapest comparable total first. Placement cannot be bought.',
        mechanism: 'ranking.paidPlacement=false is published on every search response.'
      },
      {
        id: 'freshness-disclosure',
        promise: 'Every offer is labeled live, cached, or demo. Placeholder data never poses as a real quote.',
        mechanism: 'offer.freshness and response-level freshness.'
      },
      {
        id: 'honest-failures',
        promise: 'When data sources fail, we say so instead of pretending there were no results.',
        mechanism: 'providers[].status with a coarse error category, and an explicit response message.'
      },
      {
        id: 'price-context',
        promise: 'When we have enough history, we tell you how today’s price compares to the recent average.',
        mechanism: 'priceContext appears once at least 3 samples exist for a search; demo prices are never recorded.'
      }
    ]
  };
}

export function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

export function clientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function setHeaders(res, headers) {
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function sendJson(res, statusCode, payload, context, logger) {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(payload === null ? '' : JSON.stringify(payload, null, 2));
  logger?.info('Request completed', { requestId: context.requestId, statusCode, durationMs: Date.now() - context.startedAt });
}

function sendText(res, statusCode, body, contentType, context, logger) {
  res.writeHead(statusCode, { 'content-type': contentType });
  res.end(body);
  logger?.info('Request completed', { requestId: context.requestId, statusCode, durationMs: Date.now() - context.startedAt });
}
