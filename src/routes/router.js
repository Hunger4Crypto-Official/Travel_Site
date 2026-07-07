import { success, error } from '../utils/formatter.js';
import { authenticate, createRequestContext, responseHeaders } from '../utils/http.js';
import { readJsonBody, readRawBody } from '../utils/requestBody.js';

const SOURCE = 'the-travel-club';
const SESSION_COOKIE = 'tc_session';

// Routes that accept a non-GET method, and the full method set each advertises
// in its Allow header. Every other path is GET-only.
const methodAllows = new Map([
  ['/v1/alerts', 'GET, POST, DELETE, OPTIONS'],
  ['/v1/orders', 'GET, POST, OPTIONS'],
  ['/v1/auth/signup', 'POST, OPTIONS'],
  ['/v1/auth/login', 'POST, OPTIONS'],
  ['/v1/auth/logout', 'POST, OPTIONS'],
  ['/v1/billing/subscribe', 'POST, OPTIONS'],
  ['/v1/billing/cancel', 'POST, OPTIONS'],
  ['/v1/billing/webhook', 'POST, OPTIONS'],
  ['/v1/loyalty/redeem', 'POST, OPTIONS']
]);

// The method set a path advertises. Order-item paths (/v1/orders/<id>) are
// dynamic, so they are matched by prefix rather than by an exact map key.
function allowedMethods(pathname) {
  if (methodAllows.has(pathname)) return methodAllows.get(pathname);
  if (pathname.startsWith('/v1/orders/')) return 'GET, DELETE, OPTIONS';
  return 'GET, OPTIONS';
}

const authPaths = new Set(['/v1/auth/signup', '/v1/auth/login', '/v1/auth/logout', '/v1/me']);
const billingPaths = new Set(['/v1/billing', '/v1/billing/subscribe', '/v1/billing/cancel', '/v1/billing/webhook']);
const loyaltyPaths = new Set(['/v1/loyalty', '/v1/loyalty/redeem']);

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
const advertisedRoutes = [...[...routeMap.keys()].filter((path) => path.startsWith('/v1/')), '/v1/flights/calendar', '/v1/prices/history', '/v1/alerts', '/v1/orders', '/v1/billing', '/v1/loyalty', '/v1/trust', '/v1/auth/signup', '/v1/auth/login', '/v1/me'];
const openapiPaths = new Set(['/openapi.yaml', '/openapi.json', '/v1/openapi.yaml']);
const protectedPaths = new Set(['/ready', '/metrics']);

// The API default CSP is default-src 'none' (right for JSON). The web pages are
// self-contained single files, so they need inline style/script and same-origin
// fetch, while still forbidding framing, external sources, and form exfiltration.
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Public static assets that make the web app installable (PWA). Served with a
// long cache and their correct content types.
const staticAssets = new Map([
  ['/manifest.webmanifest', 'application/manifest+json'],
  ['/sw.js', 'application/javascript; charset=utf-8'],
  ['/icon.svg', 'image/svg+xml']
]);

export async function handleRequest(req, res, { engine, brand, logger, config, openapiSpec = null, pages = {}, assets = {}, accountService = null, bookingService = null, billingService = null, loyaltyService = null }) {
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

  const url = new URL(req.url, `http://${req.headers.host}`);
  // Normalize a single trailing slash (e.g. /v1/flights/search/) so a common
  // copy-paste typo resolves to the real route instead of a 404.
  const pathname = url.pathname.length > 1 && url.pathname.endsWith('/')
    ? url.pathname.slice(0, -1)
    : url.pathname;

  // The API is GET-only except a handful of collections (alerts, auth) that
  // declare their own method set. OPTIONS is already handled above. Declared
  // routes are enforced exactly (so GET on a POST-only route is a 405 too);
  // every other route is GET-only.
  const allow = allowedMethods(pathname);
  if (!allow.split(', ').includes(req.method)) {
    res.setHeader('Allow', allow);
    return fail(405, 'Method not allowed', { allow: allow.split(', ') });
  }

  // Identity from the session cookie (consumer web app). Independent of the
  // API-key auth used by programmatic clients; either can satisfy access.
  const identity = accountService ? accountService.identify(readCookie(req, SESSION_COOKIE)) : null;

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

  // PWA assets (manifest, service worker, icon). Public and cacheable.
  if (staticAssets.has(pathname)) {
    const body = assets[pathname];
    if (!body) return fail(404, 'This asset is not available on this deployment', { path: pathname });
    res.setHeader('cache-control', 'public, max-age=3600');
    return sendText(res, 200, body, staticAssets.get(pathname), context, logger);
  }

  // Accounts and sessions. Public (no API key): these are how a consumer signs
  // in to the web app, and login must work before any credential exists.
  if (authPaths.has(pathname)) {
    if (!accountService) return fail(404, 'Accounts are not enabled on this deployment', { path: pathname });
    try {
      if (pathname === '/v1/me') {
        if (!identity) return fail(401, 'Not signed in');
        return ok(200, accountService.me(identity.user), { principal: `user:${identity.user.id}` });
      }
      if (pathname === '/v1/auth/logout') {
        res.setHeader('Set-Cookie', clearCookie(config));
        return ok(200, { signedOut: true });
      }
      const body = await readJsonBody(req);
      const result = pathname === '/v1/auth/signup' ? accountService.signup(body) : accountService.login(body);
      res.setHeader('Set-Cookie', sessionCookie(result.token, config));
      return ok(pathname === '/v1/auth/signup' ? 201 : 200, { user: result.user }, { principal: `user:${result.user.id}` });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      const message = statusCode >= 500 ? 'Unexpected error' : err.message;
      if (statusCode >= 500) logger?.warn('Auth request failed', { requestId: context.requestId, error: err.message });
      return fail(statusCode, message);
    }
  }

  // Membership billing. The webhook is public (signature-verified); managing a
  // subscription requires a signed-in member.
  if (billingPaths.has(pathname)) {
    if (!billingService) return fail(404, 'Billing is not enabled on this deployment', { path: pathname });
    try {
      if (pathname === '/v1/billing/webhook') {
        const raw = await readRawBody(req);
        return ok(200, billingService.handleWebhook(raw, req.headers['stripe-signature']));
      }
      if (!identity) return fail(401, 'Sign in to manage your membership');
      const userPrincipal = `user:${identity.user.id}`;
      if (pathname === '/v1/billing') {
        return ok(200, billingService.status(identity.user), { principal: userPrincipal });
      }
      if (pathname === '/v1/billing/subscribe') {
        const body = await readJsonBody(req);
        return ok(200, await billingService.subscribe(identity.user, body.tier), { principal: userPrincipal });
      }
      return ok(200, await billingService.cancel(identity.user), { principal: userPrincipal });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      const message = statusCode >= 500 ? 'Unexpected error' : err.message;
      if (statusCode >= 500) logger?.warn('Billing request failed', { requestId: context.requestId, error: err.message });
      return fail(statusCode, message);
    }
  }

  // Loyalty program. Both routes require a signed-in member.
  if (loyaltyPaths.has(pathname)) {
    if (!loyaltyService) return fail(404, 'Loyalty is not enabled on this deployment', { path: pathname });
    if (!identity) return fail(401, 'Sign in to view your loyalty balance');
    const userPrincipal = `user:${identity.user.id}`;
    try {
      if (pathname === '/v1/loyalty') {
        return ok(200, loyaltyService.summary(identity.user), { principal: userPrincipal });
      }
      const body = await readJsonBody(req);
      return ok(200, loyaltyService.redeem(identity.user, body.points), { principal: userPrincipal });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      const message = statusCode >= 500 ? 'Unexpected error' : err.message;
      if (statusCode >= 500) logger?.warn('Loyalty request failed', { requestId: context.requestId, error: err.message });
      return fail(statusCode, message);
    }
  }

  const authConfig = protectedPaths.has(pathname)
    ? { ...config, requireApiKey: config.requireApiKey || config.apiKeys.length > 0 }
    : config;
  const auth = authenticate(req, authConfig);
  // A signed-in session satisfies auth for consumer routes, but never for the
  // ops-only protected paths, which still require an API key.
  const authed = auth.ok || Boolean(identity && !protectedPaths.has(pathname));
  if ((authConfig.requireApiKey || protectedPaths.has(pathname)) && !authed) {
    // authed is false only when auth.ok is false, so authenticate() has already
    // supplied a concrete statusCode and message.
    return fail(auth.statusCode, auth.message);
  }
  // Owner/rate-limit identity: the signed-in user when present, else the
  // API-key or anonymous principal from header auth.
  const principal = identity && !protectedPaths.has(pathname) ? `user:${identity.user.id}` : auth.principal;
  // Membership tier drives member rates and the booking service fee.
  const tier = identity ? identity.user.tier : 'free';

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
      return ok(200, engine.priceHistorySnapshot(query.type, query), { principal });
    }

    // Price alerts / saved searches (owner-scoped by principal).
    if (pathname === '/v1/alerts') {
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        return ok(201, engine.createAlert(body.type, body, { principal }), { principal });
      }
      if (req.method === 'DELETE') {
        return ok(200, engine.deleteAlert(query.id, { principal }), { principal });
      }
      return ok(200, engine.listAlerts({ principal }), { principal });
    }

    // Managed booking. Owner-scoped orders; aggregators are the merchant of
    // record. /v1/orders is the collection, /v1/orders/<id> a single order.
    if (pathname === '/v1/orders' || pathname.startsWith('/v1/orders/')) {
      if (!bookingService) return fail(404, 'Booking is not enabled on this deployment', { path: pathname });
      if (pathname === '/v1/orders') {
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          return ok(201, await bookingService.createOrder(body, { principal, tier }), { principal });
        }
        return ok(200, bookingService.listOrders({ principal }), { principal });
      }
      const orderId = decodeURIComponent(pathname.slice('/v1/orders/'.length));
      if (req.method === 'DELETE') {
        return ok(200, await bookingService.cancelOrder(orderId, { principal }), { principal });
      }
      return ok(200, bookingService.getOrder(orderId, { principal }), { principal });
    }

    // Rate-limit per authenticated principal when available, else per client IP.
    const clientKey = principal && principal !== 'anonymous' ? principal : clientIp(req);

    if (pathname === '/v1/flights/calendar') {
      const calendar = await engine.flexibleSearch('flights', query, { clientKey }, { flexDays: query.flex });
      return ok(200, calendar, { principal });
    }

    const type = routeMap.get(pathname);
    if (!type) {
      return fail(404, 'Route not found', { path: pathname, availableRoutes: advertisedRoutes });
    }

    const data = await engine.search(type, query, { clientKey });
    return ok(200, data, { principal });
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
      signup: '/v1/auth/signup',
      login: '/v1/auth/login',
      me: '/v1/me',
      flights: `/v1/flights/search?from=LAX&to=JFK&date=${depart}`,
      flightsCalendar: `/v1/flights/calendar?from=LAX&to=JFK&date=${depart}&flex=3`,
      hotels: `/v1/hotels/search?city=Las%20Vegas&checkin=${checkin}&checkout=${checkout}`,
      cars: `/v1/cars/search?city=Miami&date=${carDate}`,
      priceHistory: '/v1/prices/history?type=flights&from=LAX&to=JFK',
      alerts: '/v1/alerts',
      orders: '/v1/orders',
      billing: '/v1/billing',
      loyalty: '/v1/loyalty',
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

export function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function sessionCookie(token, config) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(config) {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
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
