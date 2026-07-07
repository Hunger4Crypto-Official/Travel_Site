// Best-effort webhook notifier for price-alert notifications.
//
// The target URL is user-provided, so every delivery is gated by an SSRF guard
// that rejects loopback/private/link-local/unique-local literals before any
// network call is made. Delivery is best-effort: notify() never throws.
//
// NOTE: This guard only inspects URL *literals*. A public hostname that
// resolves (via DNS) to a private/internal IP is NOT blocked here; fully
// closing that hole needs resolve-then-pin at connect time and is out of
// scope. Webhooks are opt-in and off by default, which bounds the exposure.

import { fetchText } from './httpClient.js';

const RESPONSE_MAX_BYTES = 64 * 1024;

// --- IPv4 helpers -----------------------------------------------------------

// Parse a strict dotted-quad IPv4 literal into an array of four 0-255 octets,
// or return null if the string is not a canonical IPv4 address.
export function parseIpv4(host) {
  if (typeof host !== 'string') return null;
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

// True when the dotted-quad literal falls in a loopback/private/link-local
// range (or is the unspecified 0.0.0.0). Non-IPv4 input returns false.
export function isBlockedIpv4(host) {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (includes 0.0.0.0)
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (covers metadata 169.254.169.254)
  return false;
}

// --- IPv6 helpers -----------------------------------------------------------

// True when the IPv6 literal (already stripped of brackets) is loopback,
// unspecified, unique-local (fc00::/7) or link-local (fe80::/10).
export function isBlockedIpv6(host) {
  if (typeof host !== 'string' || !host.includes(':')) return false;
  const h = host.toLowerCase().trim();
  if (h === '::1') return true; // loopback
  if (h === '::') return true; // unspecified
  // Unique-local fc00::/7 -> first hextet high byte 0xfc or 0xfd.
  if (/^f[cd]/.test(h)) return true;
  // Link-local fe80::/10 -> first hextet in fe80..febf.
  if (/^fe[89ab]/.test(h)) return true;
  return false;
}

// --- SSRF guard -------------------------------------------------------------

// Note on obfuscated IP encodings (decimal 2130706433, hex 0x7f000001, octal
// 0177.0.0.1, short form 127.1): the WHATWG URL parser canonicalizes all of
// these to a dotted quad in parsed.hostname (e.g. 127.0.0.1, 169.254.169.254)
// before we inspect the host, so isBlockedIpv4 already catches them; an
// out-of-range integer makes new URL() throw, which is rejected below. Verified
// by test.
export function isAllowedWebhookUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  let host = parsed.hostname.toLowerCase();
  // URL keeps IPv6 hosts wrapped in brackets; strip them for literal checks.
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isBlockedIpv4(host)) return false;
  if (isBlockedIpv6(host)) return false;

  return true;
}

// --- Notifier ---------------------------------------------------------------

export function createNotifier({
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
  enabled = false,
  logger = null
} = {}) {
  async function notify(target, payload) {
    if (!enabled) return { delivered: false, reason: 'disabled' };
    if (!target) return { delivered: false, reason: 'no-target' };

    if (!isAllowedWebhookUrl(target)) {
      logger?.warn?.('Webhook target rejected by SSRF guard (URL redacted)');
      return { delivered: false, reason: 'blocked' };
    }

    try {
      await fetchText(target, {
        fetchImpl,
        timeoutMs,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        maxBytes: RESPONSE_MAX_BYTES
      });
      return { delivered: true, status: 200 };
    } catch (err) {
      logger?.warn?.('Webhook delivery failed (URL redacted): ' + err.message);
      return { delivered: false, reason: 'error', error: err.message };
    }
  }

  return { notify };
}
