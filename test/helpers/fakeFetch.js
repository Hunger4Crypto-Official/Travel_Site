// Test helpers that emulate the subset of the fetch API the httpClient uses:
// an object with { ok, status, text() }.

export function jsonResponse(value, { status = 200 } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return { ok: status >= 200 && status < 300, status, async text() { return body; } };
}

export function errorResponse(status) {
  return { ok: false, status, async text() { return ''; } };
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
