import { success, error } from '../utils/formatter.js';
import { authenticate, createRequestContext, responseHeaders } from '../utils/http.js';
import { readJsonBody, readRawBody } from '../utils/requestBody.js';
import { lockOffer } from '../booking/offerLock.js';
import { toPrometheus } from '../observability/prometheus.js';
import { CATEGORIES as PLACE_CATEGORIES } from '../enrichment/places.js';

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
  ['/v1/loyalty/redeem', 'POST, OPTIONS'],
  ['/v1/assistant/parse', 'POST, OPTIONS']
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
const assistantPaths = new Set(['/v1/assistant', '/v1/assistant/parse']);

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
const advertisedRoutes = [...[...routeMap.keys()].filter((path) => path.startsWith('/v1/')), '/v1/flights/calendar', '/v1/prices/history', '/v1/alerts', '/v1/orders', '/v1/billing', '/v1/loyalty', '/v1/assistant', '/v1/trust', '/v1/holidays', '/v1/concierge', '/v1/auth/signup', '/v1/auth/login', '/v1/me'];
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

export async function handleRequest(req, res, { engine, brand, logger, config, openapiSpec = null, pages = {}, assets = {}, accountService = null, bookingService = null, billingService = null, loyaltyService = null, assistantService = null, authLimiter = null, writeLimiter = null, offerSecret = null, idempotencyStore = null, auditLog = null, holidays = null, concierge = null }) {
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
  // Sends a 429 and returns true when the keyed limiter is exhausted, else
  // false. Callers do `if (throttled(...)) return;` since the response is sent.
  const throttled = (limiter, key) => {
    if (!limiter || limiter.consume(key)) return false;
    const retryAfter = limiter.retryAfterSeconds();
    res.setHeader('Retry-After', String(retryAfter));
    fail(429, 'Too many requests. Please slow down.', { retryAfter });
    return true;
  };
  // Idempotency for money/booking mutations: a repeated request with the same
  // Idempotency-Key replays the first response instead of acting twice.
  const idemKeyFor = (principalKey) => {
    const header = req.headers['idempotency-key'];
    return idempotencyStore && header ? idempotencyStore.keyFor(principalKey, req.method, url.pathname, header) : null;
  };
  const replayIdempotent = (idem) => {
    const cached = idem && idempotencyStore.get(idem);
    if (!cached) return false;
    res.setHeader('Idempotent-Replay', 'true');
    sendJson(res, cached.statusCode, cached.body, context, logger);
    return true;
  };
  const okIdempotent = (idem, statusCode, data, extraMeta = {}) => {
    const body = success(SOURCE, data, { brand: brandMeta, requestId: context.requestId, version: brand.apiVersion, ...extraMeta });
    if (idem) idempotencyStore.put(idem, statusCode, body);
    return sendJson(res, statusCode, body, context, logger);
  };
  // Immutable audit trail for security- and money-relevant actions (no-op when
  // no audit sink is configured).
  const audit = (fields) => auditLog?.record(fields);

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
  // Rate-limit key: the signed-in user when present, else the client IP.
  const rlKey = identity ? `user:${identity.user.id}` : clientIp(req, config.trustProxyHops);

  // CSRF defense-in-depth: reject a cross-origin mutating request that carries a
  // session cookie. SameSite=Lax already blocks this in browsers; this is a
  // second gate. Requests with no Origin header (API clients) are unaffected.
  if ((req.method === 'POST' || req.method === 'DELETE') && readCookie(req, SESSION_COOKIE) && !originAllowed(req, config)) {
    return fail(403, 'Cross-origin request blocked');
  }

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
    // Throttle signup/login per client IP to blunt brute force and spam.
    if ((pathname === '/v1/auth/signup' || pathname === '/v1/auth/login') && throttled(authLimiter, clientIp(req, config.trustProxyHops))) {
      return;
    }
    try {
      if (pathname === '/v1/me') {
        if (!identity) return fail(401, 'Not signed in');
        return ok(200, accountService.me(identity.user), { principal: `user:${identity.user.id}` });
      }
      if (pathname === '/v1/auth/logout') {
        // Invalidate every existing token for this user, not just this cookie.
        if (identity) { accountService.logout(identity.user); audit({ actor: identity.user.id, action: 'account.logout' }); }
        res.setHeader('Set-Cookie', clearCookie(config));
        return ok(200, { signedOut: true });
      }
      const body = await readJsonBody(req);
      const result = pathname === '/v1/auth/signup' ? await accountService.signup(body) : await accountService.login(body);
      res.setHeader('Set-Cookie', sessionCookie(result.token, config));
      audit({ actor: result.user.id, action: pathname === '/v1/auth/signup' ? 'account.signup' : 'account.login' });
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
    if (throttled(writeLimiter, rlKey)) return;
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
        const idem = idemKeyFor(userPrincipal);
        if (replayIdempotent(idem)) return;
        const body = await readJsonBody(req);
        const subscribed = await billingService.subscribe(identity.user, body.tier);
        audit({ actor: identity.user.id, action: 'billing.subscribe', target: body.tier });
        return okIdempotent(idem, 200, subscribed, { principal: userPrincipal });
      }
      const cancelled = await billingService.cancel(identity.user);
      audit({ actor: identity.user.id, action: 'billing.cancel' });
      return ok(200, cancelled, { principal: userPrincipal });
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
    if (throttled(writeLimiter, rlKey)) return;
    if (!identity) return fail(401, 'Sign in to view your loyalty balance');
    const userPrincipal = `user:${identity.user.id}`;
    try {
      if (pathname === '/v1/loyalty') {
        return ok(200, loyaltyService.summary(identity.user), { principal: userPrincipal });
      }
      const idem = idemKeyFor(userPrincipal);
      if (replayIdempotent(idem)) return;
      const body = await readJsonBody(req);
      return okIdempotent(idem, 200, loyaltyService.redeem(identity.user, body.points), { principal: userPrincipal });
    } catch (err) {
      const statusCode = err.statusCode || 500;
      const message = statusCode >= 500 ? 'Unexpected error' : err.message;
      if (statusCode >= 500) logger?.warn('Loyalty request failed', { requestId: context.requestId, error: err.message });
      return fail(statusCode, message);
    }
  }

  // Natural-language search assistant (local Ollama). Assistive only: it returns
  // a suggested structured query the caller reviews. Public; never touches money.
  if (assistantPaths.has(pathname)) {
    if (!assistantService) return fail(404, 'The assistant is not enabled on this deployment', { path: pathname });
    if (throttled(writeLimiter, rlKey)) return;
    try {
      if (pathname === '/v1/assistant') return ok(200, assistantService.status());
      const body = await readJsonBody(req);
      return ok(200, await assistantService.parseSearch(body.text));
    } catch (err) {
      const statusCode = err.statusCode || 500;
      // 400 (bad input) and 502 (model unavailable) carry client-safe messages;
      // only a true internal 500 is masked.
      const message = statusCode === 500 ? 'Unexpected error' : err.message;
      if (statusCode >= 500) logger?.warn('Assistant request failed', { requestId: context.requestId, error: err.message });
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
    const snapshot = engine.metricsSnapshot();
    // Content-negotiate: Prometheus scrapers get text exposition format, others JSON.
    if (String(req.headers.accept || '').includes('text/plain') || url.searchParams.get('format') === 'prometheus') {
      return sendText(res, 200, toPrometheus(snapshot), 'text/plain; version=0.0.4; charset=utf-8', context, logger);
    }
    return ok(200, snapshot);
  }

  try {
    const query = Object.fromEntries(url.searchParams.entries());

    if (pathname === '/v1/prices/history') {
      return ok(200, engine.priceHistorySnapshot(query.type, query), { principal });
    }

    // Public-holidays enrichment (free, keyless). Enrichment only: never pricing
    // or booking. Handy travel context for planning around a destination.
    // Enrichment 502 messages are written to be safe for clients (upstream
    // detail lives only on err.cause), so unlike the global catch we surface
    // them: an honest "this source is down" beats a generic error.
    if (pathname === '/v1/holidays') {
      if (!holidays || !holidays.enabled) return fail(404, 'Holiday enrichment is not enabled on this deployment', { path: pathname });
      try {
        return ok(200, await holidays.holidays(query.country, Number(query.year)), { principal });
      } catch (err) {
        if (err.statusCode === 502) return fail(502, err.message, { path: pathname });
        throw err;
      }
    }

    // In-trip concierge briefing (free, keyless sources). Enrichment only: it
    // composes weather, nearby places, a destination guide, and public holidays
    // and is never wired to pricing, ranking, booking, money, or compliance.
    if (pathname === '/v1/concierge') {
      if (!concierge || !concierge.enabled) return fail(404, 'Concierge is not enabled on this deployment', { path: pathname });
      if (!query.city) return fail(400, 'city is required, for example /v1/concierge?city=Lisbon', { path: pathname });
      if (query.category && !Object.hasOwn(PLACE_CATEGORIES, query.category)) {
        return fail(400, `category must be one of: ${Object.keys(PLACE_CATEGORIES).join(', ')}`, { path: pathname });
      }
      try {
        const briefing = await concierge.lookup(query.city, query.category ? { category: query.category } : {});
        return ok(200, briefing, { principal });
      } catch (err) {
        if (err.statusCode === 502) return fail(502, err.message, { path: pathname });
        throw err;
      }
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
      // Orders carry PII (passenger names, contact) and must never be shared by
      // the single 'anonymous' owner. Require an authenticated caller.
      if (principal === 'anonymous') return fail(401, 'Sign in to view or manage your bookings');
      if (throttled(writeLimiter, principal)) return;
      if (pathname === '/v1/orders') {
        if (req.method === 'POST') {
          const idem = idemKeyFor(principal);
          if (replayIdempotent(idem)) return;
          const body = await readJsonBody(req);
          const order = await bookingService.createOrder(body, { principal, tier });
          audit({ actor: principal, action: 'order.create', target: order.id, meta: { total: order.total } });
          return okIdempotent(idem, 201, order, { principal });
        }
        return ok(200, bookingService.listOrders({ principal }), { principal });
      }
      let orderId;
      try {
        orderId = decodeURIComponent(pathname.slice('/v1/orders/'.length));
      } catch {
        return fail(400, 'Invalid order id', { path: pathname });
      }
      if (req.method === 'DELETE') {
        const cancelledOrder = await bookingService.cancelOrder(orderId, { principal });
        audit({ actor: principal, action: 'order.cancel', target: orderId });
        return ok(200, cancelledOrder, { principal });
      }
      return ok(200, bookingService.getOrder(orderId, { principal }), { principal });
    }

    // Rate-limit per authenticated principal when available, else per client IP.
    const clientKey = principal && principal !== 'anonymous' ? principal : clientIp(req, config.trustProxyHops);

    if (pathname === '/v1/flights/calendar') {
      const calendar = await engine.flexibleSearch('flights', query, { clientKey }, { flexDays: query.flex });
      return ok(200, calendar, { principal });
    }

    const type = routeMap.get(pathname);
    if (!type) {
      return fail(404, 'Route not found', { path: pathname, availableRoutes: advertisedRoutes });
    }

    const data = await engine.search(type, query, { clientKey });
    // Sign each offer so it can be booked without the client tampering with its
    // price or fabricating an offer (verified in bookingService.createOrder).
    if (offerSecret && Array.isArray(data.offers)) {
      for (const offer of data.offers) offer.lock = lockOffer(offerSecret, offer);
    }
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
      assistant: '/v1/assistant',
      holidays: '/v1/holidays?country=US&year=2026',
      concierge: '/v1/concierge?city=Lisbon',
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
      },
      {
        id: 'honest-booking-totals',
        promise: 'Before you confirm a booking, we show the trip total and any service fee separately. No fee is ever hidden or pre-selected.',
        mechanism: 'order.serviceFee and order.total are disclosed on the checkout sheet and the created order; the top membership tier pays a zero fee.'
      },
      {
        id: 'easy-cancellation',
        promise: 'Cancelling a booking is as easy as making one, and any refund is shown to you.',
        mechanism: 'DELETE /v1/orders/<id> from the Trips tab; order.cancellationPolicy is stated upfront and the refund is returned on cancel.'
      },
      {
        id: 'transparent-membership',
        promise: 'Membership benefits are concrete and disclosed, and you can cancel anytime.',
        mechanism: 'Tier benefits (waived fees, loyalty multipliers, member rates) are published; POST /v1/billing/cancel downgrades immediately.'
      },
      {
        id: 'assistive-ai-only',
        promise: 'Any AI helper only suggests search fields for you to review. It never sets prices, ranks results, or books.',
        mechanism: 'The assistant output passes a strict whitelist sanitizer; the deterministic engine and validators remain authoritative.'
      },
      {
        id: 'data-protection',
        promise: 'Passwords are hashed and never stored in the clear, and we do not sell your data.',
        mechanism: 'scrypt with a per-user salt via node:crypto; card data is handled by the payment provider, never by us.'
      }
    ]
  };
}

export function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

// True when a cookie-authenticated mutating request is same-origin or from an
// allowed origin. No Origin header (non-browser clients) is treated as allowed;
// SameSite=Lax is the primary browser defense.
export function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = config.allowedOrigins || [];
  if (allowed.includes('*') || allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
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

// The client address for rate limiting. X-Forwarded-For is spoofable, so it is
// only trusted when the operator declares how many reverse-proxy hops sit in
// front (TRUST_PROXY_HOPS); we then read the address the outermost trusted proxy
// observed (the Nth entry from the right). With 0 hops (the default) the header
// is ignored entirely and the socket address, which a client cannot forge, is used.
export function clientIp(req, trustProxyHops = 0) {
  if (trustProxyHops > 0) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) {
      // Count trustProxyHops back from the right; if more hops are trusted than
      // present, every entry is from a trusted proxy so the leftmost is the client.
      const idx = Math.max(0, hops.length - trustProxyHops);
      if (hops[idx]) return hops[idx];
    }
  }
  return req.socket?.remoteAddress || 'unknown';
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
