// Single, audited network chokepoint for every outbound provider call.
// Centralizing fetch here keeps timeout handling, error shaping, and response
// size limits consistent and reviewable in one place.

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB ceiling guards against memory-exhaustion from a hostile/buggy upstream.

export class HttpError extends Error {
  constructor(message, { statusCode = 502, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    if (cause) this.cause = cause;
  }
}

export async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs,
  headers = {},
  method = 'GET',
  body = null,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  const text = await fetchText(url, { fetchImpl, timeoutMs, headers, method, body, maxBytes });
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError('Upstream returned a non-JSON response', { statusCode: 502, cause: err });
  }
}

export async function fetchText(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs,
  headers = {},
  method = 'GET',
  body = null,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new HttpError('No fetch implementation available', { statusCode: 500 });
  }

  const controller = new AbortController();
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  let response;
  try {
    response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new HttpError(`Upstream request timed out after ${timeoutMs}ms`, { statusCode: 504, cause: err });
    }
    throw new HttpError('Upstream request failed', { statusCode: 502, cause: err });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    throw new HttpError(`Upstream request failed with status ${response.status}`, { statusCode: response.status });
  }

  const text = await readCapped(response, maxBytes);
  return text;
}

async function readCapped(response, maxBytes) {
  // Reject early when the upstream declares an oversized body.
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError('Upstream response exceeded maximum allowed size', { statusCode: 502 });
  }

  // Preferred path: stream and enforce the cap incrementally so a hostile or
  // buggy upstream cannot force us to buffer an unbounded body into memory.
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength ?? value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new HttpError('Upstream response exceeded maximum allowed size', { statusCode: 502 });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // Fallback for fetch implementations that only expose text().
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new HttpError('Upstream response exceeded maximum allowed size', { statusCode: 502 });
  }
  return text;
}
