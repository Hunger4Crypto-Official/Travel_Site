// Natural-language search assistant. It turns a traveler's free text into a
// SUGGESTED structured search query and nothing more. It is deliberately walled
// off from money and compliance: it never sees or produces prices, ranking,
// fees, booking, refunds, or eligibility. The deterministic engine and
// validators remain the single source of truth; a suggestion is only a form
// pre-fill the member reviews before searching.

const TYPES = new Set(['flights', 'hotels', 'cars']);
const CODE_RE = /^[A-Za-z]{3,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT = 400;
const DISCLAIMER = 'This is a suggestion from a local AI model. Review it before searching. Prices and results always come from the live engine, never the model.';

const PROMPT_HEADER = [
  'You convert a traveler request into a JSON travel search query.',
  'Respond with JSON only, no prose.',
  'Allowed keys: type (one of flights, hotels, cars), from (3 letter IATA airport code), to (3 letter IATA airport code), date (YYYY-MM-DD), city, checkin (YYYY-MM-DD), checkout (YYYY-MM-DD).',
  'Omit any key you cannot infer. Never invent prices or any other key.',
  'Request:'
].join('\n');

export class AssistantService {
  constructor({ client } = {}) {
    this.client = client;
  }

  status() {
    return { enabled: this.client.enabled, model: this.client.model };
  }

  async parseSearch(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw badRequest('Describe your trip in a few words');
    }
    if (text.length > MAX_TEXT) {
      throw badRequest('That description is too long. Keep it under 400 characters.');
    }
    const raw = await this.client.generate(`${PROMPT_HEADER}\n${text.trim()}\nJSON:`, { format: 'json' });
    return { suggestion: sanitize(extractJson(raw)), disclaimer: DISCLAIMER };
  }
}

// Parse the model output into an object, tolerating stray text around the JSON.
// Never throws: unparseable output yields an empty object.
function extractJson(raw) {
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}

// Keep only whitelisted, well-formed fields. Everything else is dropped, so a
// hallucinated key or a price can never reach the search form.
function sanitize(parsed) {
  const out = {};
  if (!parsed || typeof parsed !== 'object') return out;
  if (typeof parsed.type === 'string' && TYPES.has(parsed.type)) out.type = parsed.type;
  for (const key of ['from', 'to']) {
    if (typeof parsed[key] === 'string' && CODE_RE.test(parsed[key].trim())) out[key] = parsed[key].trim().toUpperCase();
  }
  for (const key of ['date', 'checkin', 'checkout']) {
    if (typeof parsed[key] === 'string' && DATE_RE.test(parsed[key].trim())) out[key] = parsed[key].trim();
  }
  if (typeof parsed.city === 'string' && parsed.city.trim()) out.city = parsed.city.trim().slice(0, 120);
  return out;
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

export { sanitize, extractJson };
