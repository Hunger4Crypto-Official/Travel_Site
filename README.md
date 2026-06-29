# THE Travel Club

**THE** stands for **Travel Happier Everywhere**.

THE Travel Club is a travel aggregation engine that connects flight, hotel, car, airport, routing, and aviation data providers behind one consistent API. The verticals that need no credentials are already wired to **real** data sources; the demo provider covers the verticals that still require paid provider contracts, so the backend works end to end today.

## What this engine does today

- Exposes HTTP endpoints for flights, hotels, cars, airport info, and flight tracking.
- Returns **real airport information** for IATA/ICAO codes from a bundled public dataset (no API key, no network).
- Returns **real live flight positions** from the OpenSky Network public REST API (no API key required).
- Falls back to a demo provider for flights, hotels, and cars until those paid provider APIs are connected.
- Aggregates matching providers for a requested travel vertical.
- Validates required search parameters before touching provider quota.
- Normalizes offers into one response shape with optional affiliate metadata.
- Ranks offers by lowest known total price first, then by score.
- Supports score-first sorting with `sort=score` for future “best value” experiences.
- Adds stable, order-independent in-memory caching to reduce repeated provider calls.
- Adds a token-bucket rate limiter and per-provider timeout protection to protect provider quotas.
- Isolates provider failures (e.g. an unreachable live source) so the rest of the response still succeeds.

> This engine can compare available prices from connected providers, but it should not be marketed as a guaranteed lowest-price engine until live providers, fee normalization, availability validation, and checkout/deep-link tracking are implemented.

## API endpoints

```bash
GET /health
GET /ready
GET /metrics
GET /v1/flights/search?from=LAX&to=JFK&date=2026-07-01
GET /v1/flights/search?from=LAX&to=JFK&date=2026-07-01&sort=score
GET /v1/hotels/search?city=Las%20Vegas&checkin=2026-07-01&checkout=2026-07-05
GET /v1/cars/search?city=Miami&date=2026-07-01
GET /v1/airport/info?code=LAX
GET /v1/flights/live?icao24=abc123
```

## Unified response format

```json
{
  "status": "success",
  "source": "the-travel-club-engine",
  "data": {
    "query": {},
    "count": 0,
    "offers": [],
    "providers": []
  },
  "meta": {
    "brand": {
      "name": "THE Travel Club",
      "acronym": "Travel Happier Everywhere",
      "tagline": "Compare smarter. Travel happier. Everywhere."
    }
  }
}
```

## Project structure

```text
docs/
  enterprise-readiness.md
  openapi.yaml
src/
  config/
    brand.js
    env.js
  engine/
    normalizers.js
    providerCircuitBreaker.js
    queryValidation.js
    ranking.js
    travelEngine.js
  observability/
    logger.js
    metrics.js
  providers/
    baseProvider.js
    index.js
    mockProvider.js
  routes/
    router.js
  utils/
    cache.js
    formatter.js
    http.js
    rateLimit.js
server.js
test/
  engine.test.js
  router.test.js
```

## Installation

```bash
npm install
```

This project currently uses only Node.js built-in modules, so `npm install` does not need to download runtime dependencies.

## Run locally

```bash
npm start
```

The server defaults to `http://localhost:3000`.

## Test

```bash
npm test
npm run lint
npm run check
```

## Enterprise operations

- `docs/openapi.yaml` contains the API contract for versioned `/v1` endpoints.
- `docs/enterprise-readiness.md` documents security, operations, provider onboarding, and ranking governance.
- Runtime configuration is centralized in `src/config/env.js`.
- Use `API_KEYS`, `REQUIRE_API_KEY=true`, and `ALLOWED_ORIGINS` in shared environments.
- `/health` is public liveness; `/ready` and `/metrics` are diagnostics and should be protected.

## Security hardening

The codebase has been through a multi-lens red-team audit (SSRF/injection, auth/secrets,
DoS/resource-exhaustion, error-leakage, correctness). Notable protections:

- **Per-client rate limiting** — each authenticated principal (or client IP) gets its own token
  bucket, so one abusive caller can't exhaust everyone's quota. Tracked keys are LRU-bounded.
- **Streaming response cap** — the shared HTTP client rejects oversized upstream bodies via
  `Content-Length` and incremental streaming, so a hostile provider can't OOM the process.
- **No secret leakage** — the authenticated principal is a one-way SHA-256 fingerprint (never key
  characters); logs redact `key|token|secret|password|authorization|signature|bearer|credential`
  fields; 5xx responses expose only `Unexpected error` with no internal details.
- **Bounded input** — every query parameter is length-capped and the parameter count is limited,
  keeping the request, cache key, and downstream serialization bounded.
- **Failure isolation** — per-provider timeouts + circuit breaker; a slow/failed provider is
  reported as `error` and never blocks the rest of the response.

Two items are deployment choices rather than code defects:

- `/ready` and `/metrics` are open when no `API_KEYS` are configured (keyless local dev). Set
  `API_KEYS` (and optionally `REQUIRE_API_KEY=true`) in shared/production environments to gate them.
- Ranking compares prices numerically. When providers can return **mixed currencies**, enable
  `CURRENCY_CONVERSION_ENABLED=true` (+ `BASE_CURRENCY`) so every offer is normalized to one
  currency before ranking.

## Providers

All providers extend `BaseProvider` and are registered in `src/providers/index.js`. No-key
providers run by default; key-based providers register **only when their credentials are set**,
so an unconfigured provider never makes a network call. Every offer flows through the same
`normalizeOffer` shape and the shared, audited HTTP client (`src/utils/httpClient.js`), which
enforces per-provider timeouts and a response-size ceiling.

| Provider | Verticals | Credentials | Notes |
|---|---|---|---|
| Demo (`the-travel-club-demo`) | flights, hotels, cars | none | Placeholder data for verticals awaiting paid contracts. |
| IATA/ICAO reference | airports | none | Bundled dataset (`src/providers/data/airports.js`), fully offline. |
| OpenSky Network | tracking | none (optional login) | Live flight positions. `OPENSKY_USERNAME`/`OPENSKY_PASSWORD` raise rate limits. |
| ADS-B (adsb.lol, airplanes.live) | tracking | none | Community ADS-B fallbacks alongside OpenSky. |
| Amadeus Self-Service | flights | `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET` | OAuth2 token cached until expiry. `AMADEUS_ENV=test\|production`. |
| Hotelbeds APItude | hotels | `HOTELBEDS_API_KEY`, `HOTELBEDS_SECRET` | SHA256-signed; needs a `cityCode` query param. `HOTELBEDS_ENV=test\|production`. |
| AeroDataBox (RapidAPI) | airports | `AERODATABOX_RAPIDAPI_KEY` | Live airport detail enrichment. |
| Travelpayouts Data API | flights | `TRAVELPAYOUTS_TOKEN` (`TRAVELPAYOUTS_MARKER`) | Cached cheapest fares (7-day cache). |

> **Aviationstack** is intentionally not wired: its endpoints key on a flight *number*, not the
> `icao24` transponder hex the tracking vertical uses, so it cannot map cleanly to the current
> contract.

⚠️ **Network egress:** every external host (`opensky-network.org`, `api.adsb.lol`,
`api.airplanes.live`, `*.amadeus.com`, `api.test.hotelbeds.com`, `aerodatabox.p.rapidapi.com`,
`api.travelpayouts.com`, `api.frankfurter.app`) must be allowed by the environment's network
policy. When a host is blocked or a provider fails, the engine isolates it (circuit breaker +
timeout), reports it as `error`, and still returns offers from the providers that succeeded.

### Toggles & currency

- Disable providers with `DEMO_PROVIDER_ENABLED=false`, `AIRPORT_PROVIDER_ENABLED=false`,
  `OPENSKY_ENABLED=false`, `ADSB_ENABLED=false`.
- Set `CURRENCY_CONVERSION_ENABLED=true` and `BASE_CURRENCY=USD` to normalize every offer's price
  into one currency (via the free, no-key Frankfurter API) before ranking, so cross-provider price
  comparison is apples-to-apples.

## Future monetization hooks

The engine is structured to support revenue features later:

- Affiliate or partner deep links on each offer.
- Sponsored placements with clear disclosure.
- Premium price alerts.
- B2B API tiers for other travel apps.
- White-label widgets for publishers and travel agencies.

## Provider integration checklist

Provider modules should return normalized offers that include the final comparable price available from that provider. When affiliate or partner IDs are available, pass them into `normalizeOffer` so booking links can be tracked without changing the public response contract. The engine will isolate provider failures, enforce timeouts, and continue returning offers from successful providers.

When a real provider API is available:

1. Add a provider module under `src/providers/` that extends `BaseProvider`.
2. Implement `supports(type)` for the verticals the provider can search.
3. Implement `search(type, query)` and map provider-specific results through `normalizeOffer`.
4. Register the provider in `src/providers/index.js`.
5. Add tests covering normalization, ranking, and fallback behavior.
6. Confirm each provider's caching, display, affiliate, and pricing rules before production use.
