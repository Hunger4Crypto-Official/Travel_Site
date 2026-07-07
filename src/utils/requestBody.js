const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB is plenty for an alert definition.

// Reads a request body with a hard size cap, so the write endpoints can accept
// input without letting a client stream an unbounded body into memory. Rejects
// with a 400-tagged error on oversize; resolves with the exact raw string
// (webhook signature verification needs the bytes exactly as sent).
export function readRawBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
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
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => done(reject, badRequest('Could not read request body')));
  });
}

// JSON-parses the capped body. Rejects with a 400-tagged error on malformed
// JSON; an empty body resolves to {}.
export async function readJsonBody(req, options) {
  const text = (await readRawBody(req, options)).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
