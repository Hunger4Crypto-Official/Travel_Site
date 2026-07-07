import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_TTL_MS = 604800000;

// Stateless, HMAC-signed session tokens. A token is `payloadB64.sigB64`; the
// payload carries the user id and an absolute expiry. Verification is fully
// self-contained: no server-side storage, no revocation list. The signature is
// checked in constant time before any payload byte is trusted.
export function createSessionManager({ secret, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() }) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('secret must be a non-empty string');
  }

  function issue(userId) {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw badRequest('userId must be a non-empty string');
    }
    const payloadB64 = base64url(JSON.stringify({ uid: userId, exp: now() + ttlMs }));
    const sigB64 = sign(payloadB64);
    return `${payloadB64}.${sigB64}`;
  }

  function verify(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;

    // Verify signature before trusting anything in the payload.
    const expected = Buffer.from(sign(payloadB64), 'utf8');
    const provided = Buffer.from(sigB64, 'utf8');
    if (expected.length !== provided.length) return null;
    if (!timingSafeEqual(expected, provided)) return null;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      // A malformed or truncated payload is simply not a valid session.
      return null;
    }
    if (!payload || typeof payload.uid !== 'string' || typeof payload.exp !== 'number') {
      return null;
    }
    if (payload.exp <= now()) return null;
    return { userId: payload.uid, exp: payload.exp };
  }

  function sign(payloadB64) {
    return createHmac('sha256', secret).update(payloadB64).digest('base64url');
  }

  return { issue, verify };
}

function base64url(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
