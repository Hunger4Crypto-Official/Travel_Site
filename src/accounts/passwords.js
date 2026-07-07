import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Self-describing scrypt password hashing with zero dependencies.
// Format: scrypt$<N>$<r>$<p>$<saltBase64url>$<hashBase64url>
// Hashing is async (scrypt runs on the libuv thread pool) so a burst of signups
// or logins never blocks the event loop.
const PREFIX = 'scrypt';
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MIN_LENGTH = 8;
const scryptAsync = promisify(scrypt);

// Derive a KEYLEN-byte key from a password and salt using the fixed params.
function derive(plain, salt) {
  return scryptAsync(plain, salt, KEYLEN, { N, r: R, p: P });
}

// Strict base64url decode. Buffer.from silently drops invalid characters, so
// we reject anything outside the base64url alphabet to make bad input fail.
function decodeBase64url(value) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('invalid base64url');
  }
  return Buffer.from(value, 'base64url');
}

// Hash a plaintext password. Throws a 400-style error for client-fixable
// input problems (wrong type, empty, or too short).
export async function hashPassword(plain) {
  if (typeof plain !== 'string') {
    throw badRequest('password must be a string');
  }
  if (plain.length === 0) {
    throw badRequest('password must not be empty');
  }
  if (plain.length < MIN_LENGTH) {
    throw badRequest(`password must be at least ${MIN_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const hash = await derive(plain, salt);
  return [
    PREFIX,
    N,
    R,
    P,
    salt.toString('base64url'),
    hash.toString('base64url')
  ].join('$');
}

// Verify a plaintext password against a stored hash string. Never throws:
// any malformed input or mismatch returns false; only an exact match is true.
export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  if (parts[0] !== PREFIX) return false;
  let salt;
  let expected;
  try {
    salt = decodeBase64url(parts[4]);
    expected = decodeBase64url(parts[5]);
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  const actual = await derive(plain, salt);
  return timingSafeEqual(actual, expected);
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
