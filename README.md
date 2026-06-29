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

## API keys planned for future provider integrations

Create a `.env` file when live providers are ready. The engine is designed so each provider module can read its own key and be registered from `src/providers/index.js`.

```bash
SKYSCANNER_KEY=
KIWI_KEY=
PRICELINE_KEY=
AERODATABOX_KEY=
AVIATIONSTACK_KEY=
BOOKING_KEY=
EXPEDIA_KEY=
HOTELBEDS_KEY=
TRUEWAY_KEY=
```

Public or no-key data sources already wired in:

- **OpenSky Network** powers live flight tracking (`/v1/flights/live`). Anonymous access needs no key; optional `OPENSKY_USERNAME`/`OPENSKY_PASSWORD` raise the rate limit. The host `opensky-network.org` must be reachable through the environment's network egress policy for live data; when it is blocked or unreachable, the engine reports that provider as `error` and still returns the rest of the response.
- A bundled **IATA/ICAO airport dataset** (`src/providers/data/airports.js`) powers airport info (`/v1/airport/info`) with no network access. Add more airports to that file to widen coverage.

Provider toggles: set `OPENSKY_ENABLED=false` or `AIRPORT_PROVIDER_ENABLED=false` to disable either real provider; `DEMO_PROVIDER_ENABLED=false` disables the demo flights/hotels/cars data.

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
