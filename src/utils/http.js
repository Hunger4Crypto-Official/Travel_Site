import { randomUUID, timingSafeEqual } from 'node:crypto';

export function createRequestContext(req) {
  return {
    requestId: req.headers['x-request-id'] || randomUUID(),
    startedAt: Date.now()
  };
}

export function responseHeaders({ requestId, origin, allowedOrigins = [] }) {
  const headers = {
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type, x-request-id, x-api-key, authorization',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'vary': 'Origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-request-id': requestId
  };

  if (isOriginAllowed(origin, allowedOrigins)) {
    headers['access-control-allow-origin'] = origin;
  }

  return headers;
}

export function isOriginAllowed(origin, allowedOrigins = []) {
  if (!origin) return false;
  return allowedOrigins.includes('*') || allowedOrigins.includes(origin);
}

export function authenticate(req, { requireApiKey = false, apiKeys = [] } = {}) {
  if (!requireApiKey) return { ok: true, principal: 'anonymous' };
  const headerKey = req.headers['x-api-key'];
  const authorization = req.headers.authorization || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  const presented = headerKey || bearer;
  if (!presented) return { ok: false, statusCode: 401, message: 'Authentication required' };

  const matched = apiKeys.some((key) => safeEqual(key, presented));
  return matched
    ? { ok: true, principal: `api-key:${hashPreview(presented)}` }
    : { ok: false, statusCode: 403, message: 'Forbidden' };
}

function safeEqual(expected, actual) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function hashPreview(value) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
