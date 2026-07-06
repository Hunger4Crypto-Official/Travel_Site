const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB is plenty for an alert definition.

// Reads and JSON-parses a request body with a hard size cap, so the write
// endpoints (alerts) can accept input without letting a client stream an
// unbounded body into memory. Rejects with a 400-tagged error on oversize or
// malformed JSON; an empty body resolves to {}.
export function readJsonBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        done(reject, badRequest('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return done(resolve, {});
      try {
        done(resolve, JSON.parse(text));
      } catch {
        done(reject, badRequest('Request body must be valid JSON'));
      }
    });
    req.on('error', () => done(reject, badRequest('Could not read request body')));
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
