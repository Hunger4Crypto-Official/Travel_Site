// Thin client for a local Ollama server, used only for assistive text parsing.
//
// Shape mirrors src/booking/duffelAdapter.js and src/utils/notifier.js: a factory
// that takes an injected network function (fetchJson) so it is trivially testable,
// and never leaks raw upstream errors to the caller. Client-facing strings avoid
// em dashes on purpose.
//
// --- Real Ollama endpoint (documented) --------------------------------------
// Ollama exposes a local generate endpoint: POST {baseUrl}/api/generate with a
// JSON body { model, prompt, stream: false, format? } and responds with a JSON
// object { response: "<text>", ... }. This client is used ONLY for assistive
// text parsing (turning free text into structured hints); it is NEVER used for
// pricing or booking decisions, which run through audited provider adapters.

function clientError(message, statusCode, cause) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (cause) err.cause = cause;
  return err;
}

export function createOllamaClient({
  baseUrl = 'http://localhost:11434',
  model = 'llama3.2',
  enabled = false,
  fetchJson = null,
  timeoutMs = 20000
} = {}) {
  // Strip a single trailing slash so URL joins stay clean.
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

  async function generate(prompt, options = {}) {
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw clientError('A prompt is required', 400);
    }

    const payload = { model, prompt, stream: false };
    if (options.format === 'json') {
      payload.format = 'json';
    }

    let data;
    try {
      data = await fetchJson(`${normalizedBaseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs
      });
    } catch (err) {
      throw clientError('The assistant is unavailable right now. Please try again.', 502, err);
    }

    if (typeof data?.response !== 'string') {
      throw clientError('The assistant returned an unexpected response.', 502);
    }

    return data.response.trim();
  }

  return {
    enabled: Boolean(enabled),
    model,
    baseUrl: normalizedBaseUrl,
    generate
  };
}
