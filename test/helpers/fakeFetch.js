// Test helpers that emulate the subset of the fetch API the httpClient uses:
// an object with { ok, status, text() }.

export function jsonResponse(value, { status = 200 } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

export function errorResponse(status) {
  return { ok: false, status, async text() { return ''; } };
}

// A response that exposes a streaming body (getReader) and headers.get, like a
// real fetch Response, so the httpClient's incremental size-cap path is tested.
export function streamResponse(chunks, { status = 200, contentLength } = {}) {
  const encoded = chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c));
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (i >= encoded.length) return { done: true, value: undefined };
            return { done: false, value: encoded[i++] };
          },
          async cancel() { i = encoded.length; }
        };
      }
    },
    async text() { return Buffer.concat(encoded).toString('utf8'); }
  };
}

// Returns a fetch stub that always resolves to `response` and records calls.
export function stubFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return typeof response === 'function' ? response(url, options) : response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// A fetch stub that rejects, to exercise network-failure paths.
export function rejectingFetch(error = new Error('network down')) {
  return async () => { throw error; };
}

// A fetch stub that aborts when signalled, to exercise the timeout path.
export function abortingFetch() {
  return (_url, options = {}) => new Promise((_resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) return reject(abortError());
    signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}
