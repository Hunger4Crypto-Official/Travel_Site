import { success, error } from '../utils/formatter.js';
import { authenticate, createRequestContext, responseHeaders } from '../utils/http.js';

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

const protectedPaths = new Set(['/ready', '/metrics']);

export async function handleRequest(req, res, { engine, brand, logger, config }) {
  const context = createRequestContext(req);
  setHeaders(res, responseHeaders({ requestId: context.requestId, origin: req.headers.origin, allowedOrigins: config.allowedOrigins }));

  if (req.method === 'OPTIONS') return sendJson(res, 204, null, context, logger);
  if (req.method !== 'GET') return sendJson(res, 405, error('Method not allowed', 405), context, logger);

  const url = new URL(req.url, `http://${req.headers.host}`);
  logger?.info('Request started', { requestId: context.requestId, method: req.method, path: url.pathname });

  if (url.pathname === '/health') {
    return sendJson(res, 200, success('the-travel-club', { ok: true, brand: brand.name }, { requestId: context.requestId }), context, logger);
  }

  const authConfig = protectedPaths.has(url.pathname)
    ? { ...config, requireApiKey: config.requireApiKey || config.apiKeys.length > 0 }
    : config;
  const auth = authenticate(req, authConfig);
  if ((authConfig.requireApiKey || protectedPaths.has(url.pathname)) && !auth.ok) {
    return sendJson(res, auth.statusCode, error(auth.message, auth.statusCode), context, logger);
  }

  if (url.pathname === '/ready') {
    const readiness = engine.readiness();
    return sendJson(res, readiness.ok ? 200 : 503, success('the-travel-club', { ...readiness, brand }, { requestId: context.requestId }), context, logger);
  }

  if (url.pathname === '/metrics') {
    return sendJson(res, 200, success('the-travel-club', engine.metricsSnapshot(), { requestId: context.requestId }), context, logger);
  }

  const type = routeMap.get(url.pathname);
  if (!type) {
    return sendJson(res, 404, error('Route not found', 404, { path: url.pathname }), context, logger);
  }

  try {
    const query = Object.fromEntries(url.searchParams.entries());
    // Rate-limit per authenticated principal when available, else per client IP.
    const clientKey = auth.principal && auth.principal !== 'anonymous' ? auth.principal : clientIp(req);
    const data = await engine.search(type, query, { clientKey });
    return sendJson(res, 200, success('the-travel-club-engine', data, { brand, requestId: context.requestId, principal: auth.principal }), context, logger);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    const publicMessage = statusCode >= 500 ? 'Unexpected error' : err.message;
    // On 5xx only expose details that were explicitly marked public; never the
    // raw internal err.details, which may carry implementation specifics.
    const publicDetails = statusCode >= 500 ? err.publicDetails : (err.publicDetails || err.details);
    logger?.warn('Request failed', { requestId: context.requestId, statusCode, error: err.message, details: err.details });
    return sendJson(res, statusCode, error(publicMessage, statusCode, publicDetails), context, logger);
  }
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
