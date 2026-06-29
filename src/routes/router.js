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
const advertisedRoutes = [...routeMap.keys()].filter((path) => path.startsWith('/v1/'));
const openapiPaths = new Set(['/openapi.yaml', '/openapi.json', '/v1/openapi.yaml']);
const protectedPaths = new Set(['/ready', '/metrics']);

export async function handleRequest(req, res, { engine, brand, logger, config, openapiSpec = null }) {
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
  logger?.info('Request started', { requestId: context.requestId, method: req.method, path: url.pathname });

  // Discovery: a root index so the first request a developer makes is useful.
  if (url.pathname === '/' || url.pathname === '') {
    res.setHeader('cache-control', 'public, max-age=300');
    return ok(200, serviceIndex(brand));
  }

  if (url.pathname === '/health') {
    return ok(200, { ok: true, brand: brand.name });
  }

  if (openapiPaths.has(url.pathname)) {
    if (!openapiSpec) return fail(404, 'OpenAPI specification is not available', { path: url.pathname });
    res.setHeader('cache-control', 'public, max-age=300');
    return sendText(res, 200, openapiSpec, 'application/yaml', context, logger);
  }

  const authConfig = protectedPaths.has(url.pathname)
    ? { ...config, requireApiKey: config.requireApiKey || config.apiKeys.length > 0 }
    : config;
  const auth = authenticate(req, authConfig);
  if ((authConfig.requireApiKey || protectedPaths.has(url.pathname)) && !auth.ok) {
    return fail(auth.statusCode, auth.message);
  }

  if (url.pathname === '/ready') {
    const readiness = engine.readiness();
    return ok(readiness.ok ? 200 : 503, readiness);
  }

  if (url.pathname === '/metrics') {
    return ok(200, engine.metricsSnapshot());
  }

  const type = routeMap.get(url.pathname);
  if (!type) {
    return fail(404, 'Route not found', { path: url.pathname, availableRoutes: advertisedRoutes });
  }

  try {
    const query = Object.fromEntries(url.searchParams.entries());
    // Rate-limit per authenticated principal when available, else per client IP.
    const clientKey = auth.principal && auth.principal !== 'anonymous' ? auth.principal : clientIp(req);
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

function serviceIndex(brand) {
  return {
    service: brand.name,
    acronym: brand.acronym,
    tagline: brand.tagline,
    version: brand.apiVersion,
    documentation: '/openapi.yaml',
    endpoints: {
      health: '/health',
      readiness: '/ready',
      metrics: '/metrics',
      flights: '/v1/flights/search?from=LAX&to=JFK&date=2026-07-01',
      hotels: '/v1/hotels/search?city=Las%20Vegas&checkin=2026-07-01&checkout=2026-07-05',
      cars: '/v1/cars/search?city=Miami&date=2026-07-01',
      airport: '/v1/airport/info?code=LAX',
      tracking: '/v1/flights/live?icao24=4b1814'
    }
  };
}

function clientIp(req) {
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
