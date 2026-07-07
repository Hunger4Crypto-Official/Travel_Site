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

## Trust by design

Competitive research across OTAs and travel clubs
([docs/research/competitive-landscape.md](docs/research/competitive-landscape.md)) shows the same
pattern everywhere: trusted travel brands convert normally hidden costs into explicit, published
commitments, and the distrusted ones get caught doing the opposite (the FTC's Junk Fees Rule,
Hopper's $35M settlement, Fareportal's fabricated scarcity counters). This engine publishes its
commitments and enforces each one in the API contract:

- **`GET /v1/trust`** returns the machine-readable manifest: all-in pricing, no fake urgency, no
  paid ranking, freshness disclosure, honest failures, and price context (each with the mechanism
  that enforces it).
- **`ranking: { basis, paidPlacement: false }`** is published on every search response.
- **Price memory**: every search records the cheapest *real* price (demo data is never recorded).
  Once 3+ samples exist, responses carry `priceContext` ("current $289 is 12% below the 30-day
  average") with a +/-5% band so tiny wobbles read as "near average", not hype. History is queryable
  at `/v1/prices/history` and optionally persists to a JSONL file (`PRICE_HISTORY_FILE`).

## Price alerts and saved searches

A **watch** is a saved search; give it a `threshold` and it becomes a price alert. Watches are
owner-scoped by the authenticated principal (the signed-in member `user:<id>`, an API-key
fingerprint, or `anonymous` in keyless local dev), so callers only see and delete their own. A
background sweep (`ALERTS_CHECK_INTERVAL_MS`)
re-runs each watch cache-shared with normal search, records the price into price memory, and marks
a watch `triggered` the first time its cheapest total crosses at/below the threshold (resetting when
it climbs back). Manage them at `/v1/alerts` (`GET` list, `POST` create, `DELETE ?id=`).

- **Webhook delivery is opt-in and off by default.** Set `ALERTS_WEBHOOKS_ENABLED=true` to POST a
  JSON payload to a watch's `notifyUrl` when it triggers. The target is SSRF-guarded (http/https
  only; loopback, private, link-local and cloud-metadata IP literals are blocked) and the URL is
  **never echoed back** in responses (only `notifyConfigured`). Residual caveat: the guard checks URL
  literals, not DNS resolution, so a public hostname that resolves to a private IP is not fully
  covered; keep webhooks off unless you trust the operators who create alerts.
- A watch whose date has passed is deactivated on the next sweep instead of erroring.

## Accounts and membership

Members sign up and sign in at `/v1/auth/signup` and `/v1/auth/login`; both set a stateless,
HMAC-signed session cookie (`tc_session`, HttpOnly, SameSite=Lax, Secure in production). `/v1/me`
returns the signed-in member and `/v1/auth/logout` clears the cookie. A valid session both scopes
watches to that member and satisfies auth for consumer routes, so an end user never needs an API
key (API keys remain for programmatic clients and the ops-only `/ready` and `/metrics`).

- **Passwords** are hashed with `scrypt` (per-user random salt) using only `node:crypto`; the hash
  never leaves the service, and no response shape includes it.
- **Membership tiers** ship as a catalog (`src/accounts/membership.js`): Explorer (free), Voyager,
  and Globetrotter. Higher tiers unlock member-only rates and higher loyalty multipliers; billing
  and the member-rate gate arrive in later phases.
- **Persistence** mirrors the rest of the engine: in-memory by default, best-effort JSONL when
  `ACCOUNTS_FILE` is set, and a Postgres-backed store can replace it behind the same method surface
  for production scale.
- Accounts can be disabled entirely with `ACCOUNTS_ENABLED=false` (the auth routes then return 404).

## Managed booking

Search finds the lowest price; booking closes the loop. `POST /v1/orders` books a selected offer
through an aggregator that is the merchant of record (Duffel for flights, a bedbank such as
Hotelbeds for hotels), so the club owns the member relationship without taking on card processing
or ticketing liability directly. Orders are owner-scoped: `GET /v1/orders` lists yours,
`GET /v1/orders/<id>` fetches one, `DELETE /v1/orders/<id>` cancels it.

- **Order lifecycle:** `pending -> confirmed` on a successful booking, `failed` (persisted and
  auditable) when the aggregator declines, and `cancelled` (with any refund) after a cancel.
- **All-in, tier-aware pricing:** the trip total plus a booking service fee, disclosed separately.
  The Globetrotter (gold) tier has the fee waived; other tiers pay a flat percentage.
- **Sandbox by default:** each adapter runs in a deterministic simulation until real credentials
  are set (`DUFFEL_TOKEN` for flights; `HOTELBEDS_API_KEY`/`HOTELBEDS_SECRET` for hotels), so the
  full flow, including confirmations and cancellations, is exercisable end to end without live keys.
  Set `BOOKING_ENABLED=false` to disable `/v1/orders` entirely.

## Membership billing

Paid tiers are the recurring half of the hybrid model. `POST /v1/billing/subscribe` puts the
signed-in member on a paid tier (Voyager or Globetrotter) through Stripe, which is the merchant of
record for the subscription; `POST /v1/billing/cancel` downgrades them; `GET /v1/billing` reports
status. A signed subscription upgrade takes effect immediately across the product: member rates
unlock, loyalty multipliers rise, and the Globetrotter (gold) tier stops paying booking service
fees.

- **Gateway webhooks:** `POST /v1/billing/webhook` receives Stripe events. When `STRIPE_WEBHOOK_SECRET`
  is set the signature is verified (HMAC-SHA256 over the raw body with a timestamp tolerance) before
  anything is applied; a cancellation event downgrades the member to free.
- **Sandbox by default:** with no `STRIPE_SECRET_KEY` the gateway runs a deterministic simulation, so
  subscribe, cancel, and webhooks all work end to end without live keys. Set `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, and the per-tier price ids (`STRIPE_PRICE_SILVER`, `STRIPE_PRICE_GOLD`) to
  go live. `BILLING_ENABLED=false` disables `/v1/billing` entirely.

## Loyalty program

Every confirmed booking earns loyalty points equal to the trip total times the member's tier
multiplier (Explorer 1x, Voyager 2x, Globetrotter 3x). `GET /v1/loyalty` shows the balance,
multiplier, and transaction history; `POST /v1/loyalty/redeem` burns points for account credit at
100 points per USD. Balances live on the member record; the ledger keeps the per-transaction
history (in-memory by default, best-effort JSONL when `LOYALTY_FILE` is set). The earn is wired into
booking, so it is a real member benefit that compounds with the waived fees and member rates of the
paid tiers. `LOYALTY_ENABLED=false` disables `/v1/loyalty`.

Together the paid tiers deliver concrete, honest member value: waived booking service fees
(Globetrotter), higher loyalty multipliers, and the plumbing for provider closed-user-group rates
to surface only to members when a supplier offers them.

## Lowest-price comparison

For each vertical the engine fans out to every connected provider in parallel, then makes the
comparison genuinely trustworthy:

- **All-in totals.** Every price carries `{ amount, total, base, currency, estimated }`. Ranking
  uses the comparable `total` (base + taxes + fees), not whatever headline number a provider returns.
- **De-duplication.** The same flight/hotel sold by multiple providers collapses into one offer;
  the cheapest wins and the rest appear under `offer.alternatives` so you still see every price.
- **Honest comparability.** `priceComparable` is `true` only when offers share one currency **and**
  every price is a verified all-in total. A cached/estimated fare or a currency mismatch flips it to
  `false` with an explanatory `message` instead of silently mis-ranking.
- **Freshness.** Each offer is `live`, `cached`, or `demo` (placeholder); the result's `freshness`
  is that shared value, or `mixed` when offers disagree. Live data wins ties, and demo data never
  claims to be live.
- **Summaries.** `cheapest` (overall lowest, independent of display `sort`) and `bestByProvider`
  (each provider's best price) are always present.

The **demo provider automatically stops serving a vertical once a real provider is connected**, so
placeholder data can never win a real race. Cross-currency comparison requires
`CURRENCY_CONVERSION_ENABLED=true` (normalizes to `BASE_CURRENCY`).

### Proving the mappings

Because provider responses are only as trustworthy as the mapping, every mapper is checked two ways:

- **Contract tests** (`test/contract.test.js`) run each mapper against a recorded, real-shaped API
  response in `test/fixtures/`. This is the offline proof that field mappings are correct.
- **Live smoke** (`npm run smoke:live`) hits each configured provider once against the real API and
  prints the normalized result, so a mapping is proven end-to-end the moment credentials and network
  egress are available. Unconfigured or unreachable providers are reported and skipped.

## Web app and operations console

The engine ships its own zero-dependency UI, served straight from `public/` with no build step:

- **`/app`** (also what browsers get at `/` via content negotiation): a mobile-first, cinematic
  progressive web app (installable, offline shell via a service worker, safe-area aware, bottom tab
  bar). It carries the full member journey: search flights/hotels/cars with all-in prices, a
  touch-first booking sheet that shows the trip total and the tier-aware service fee before you
  confirm, a booking confirmation with points earned, a Trips tab (view and cancel orders), and an
  Account tab (membership tier and upgrade/cancel, loyalty balance and redemption, price watches).
  It renders the trust machinery visibly: all-in totals, estimate warnings, freshness chips
  (live/cached/demo), "no paid placement", and a link to the trust manifest. Served with the app
  manifest, service worker, and icon at `/manifest.webmanifest`, `/sw.js`, and `/icon.svg`.
- **`/admin`**: a live operations console polling `/ready` and `/metrics`: provider readiness and
  circuit state, latency bars, cache hit rate, rate-limit counters, the published trust manifest,
  and a price-history explorer. Paste an API key in the header when diagnostics are protected.

Both pages are self-contained single files (inline CSS/JS, no external requests) and are served
with their own strict CSP; the JSON API keeps its `default-src 'none'` policy.

## API endpoints

```bash
GET /                       # service index: brand, version, endpoint discovery
GET /openapi.yaml           # the live API contract (also /openapi.json, /v1/openapi.yaml)
GET /health
GET /ready
GET /metrics
GET /v1/trust               # public machine-readable trust commitments
GET /v1/flights/search?from=LAX&to=JFK&date=2027-05-01
GET /v1/flights/search?from=LAX&to=JFK&date=2027-05-01&sort=score&limit=5
GET /v1/flights/calendar?from=LAX&to=JFK&date=2027-05-01&flex=3   # cheapest price per day (+/- flex days)
GET /v1/hotels/search?city=Las%20Vegas&cityCode=LAS&checkin=2027-05-01&checkout=2027-05-05
GET /v1/cars/search?city=Miami&date=2027-05-01
GET /v1/prices/history?type=flights&from=LAX&to=JFK
GET    /v1/alerts                                # list your price alerts / saved searches
POST   /v1/alerts   {"type":"flights","from":"LAX","to":"JFK","date":"2027-05-01","threshold":250}
DELETE /v1/alerts?id=<id>
POST   /v1/auth/signup   {"email":"you@example.com","password":"correct-horse"}   # sets session cookie
POST   /v1/auth/login    {"email":"you@example.com","password":"correct-horse"}
POST   /v1/auth/logout
GET    /v1/me                                    # the signed-in member (tier, benefits, loyalty)
GET    /v1/orders                                # list your booking orders
POST   /v1/orders   {"type":"flights","offer":{...},"passengers":[{"givenName":"Ada","familyName":"Lovelace"}],"contact":{"email":"you@example.com"}}
GET    /v1/orders/<id>                           # fetch one order
DELETE /v1/orders/<id>                           # cancel one order
GET    /v1/billing                               # your subscription status
POST   /v1/billing/subscribe   {"tier":"gold"}   # upgrade to a paid tier
POST   /v1/billing/cancel                        # cancel and downgrade to free
POST   /v1/billing/webhook                       # gateway events (signature-verified)
GET    /v1/loyalty                               # your points balance and history
POST   /v1/loyalty/redeem   {"points":500}       # redeem points for account credit
GET /v1/airport/info?code=LAX
GET /v1/flights/live?icao24=4b1814
```

The dates above are placeholders; use any date that is today or later (past dates return a `400`).
`GET /` returns the same examples with live, always-valid future dates. Flight `from`/`to` and the
airport `code` are 3-letter IATA or 4-letter ICAO codes; hotels and cars accept a free-text `city`.

Common query parameters: `sort` (`price` | `score`), `limit` (1–50), and the numeric
`adults` / `children` / `rooms`. Invalid values return a `400` naming the field. A throttled
request returns `429` with a `Retry-After` header; `405` responses include an `Allow` header.

## Unified response format

```json
{
  "status": "success",
  "source": "the-travel-club",
  "data": {
    "query": { "from": "LAX", "to": "JFK", "date": "2027-05-01" },
    "sort": "price",
    "count": 1,
    "total": 1,
    "currency": "USD",
    "priceComparable": true,
    "freshness": "live",
    "cheapest": { "offerId": "sky-scrapper-…", "provider": "sky-scrapper", "price": { "amount": 312.4, "total": 312.4, "currency": "USD", "estimated": false } },
    "bestByProvider": [
      { "provider": "sky-scrapper", "offerId": "sky-scrapper-…", "price": { "amount": 312.4, "total": 312.4, "currency": "USD", "estimated": false } }
    ],
    "offers": [
      {
        "id": "sky-scrapper-…",
        "provider": "sky-scrapper",
        "price": { "amount": 312.4, "total": 312.4, "base": 260, "currency": "USD", "estimated": false },
        "freshness": "live",
        "alternatives": [
          { "provider": "travelpayouts", "offerId": "…", "price": { "amount": 320, "total": 320, "currency": "USD", "estimated": true } }
        ]
      }
    ],
    "providers": [
      { "provider": "sky-scrapper", "status": "success" },
      { "provider": "travelpayouts", "status": "success" }
    ]
  },
  "meta": {
    "brand": {
      "name": "THE Travel Club",
      "acronym": "Travel Happier Everywhere",
      "tagline": "Compare smarter. Travel happier. Everywhere."
    },
    "requestId": "…",
    "version": "1.0.0"
  }
}
```

`count` is the number of offers returned (after any `limit`); `total` is how many matched before
limiting. `message` appears when nothing matched, when results include estimated/demo prices, or
when some sources were unavailable, so a zero-result response tells you whether the search was
genuinely empty or whether providers were down. Each entry in `providers` is `success` or `error`;
an errored entry carries a coarse `error` category (`timeout`, `auth`, `rate_limited`, or
`unavailable`) with no internal detail. Every response (success or error) carries `meta.requestId`
and `meta.version`. Error responses use `{ "status": "error", "error": { message, statusCode,
details }, "meta": { requestId, version } }`.

## Project structure

```text
docs/
  enterprise-readiness.md
  openapi.yaml
scripts/
  liveSmoke.js              # prove provider mappings against the real APIs
src/
  config/
    brand.js
    dotenv.js               # zero-dependency .env loader
    env.js                  # single source of truth for configuration
  engine/
    dedupe.js               # cross-provider offer de-duplication
    normalizers.js          # all-in price model + offer shape
    providerCircuitBreaker.js
    queryValidation.js
    ranking.js
    travelEngine.js
  observability/
    logger.js
    metrics.js
  providers/
    adsbProvider.js         # adsb.lol / airplanes.live (no key)
    aeroDataBoxProvider.js  # RapidAPI airport enrichment
    airportInfoProvider.js  # bundled IATA/ICAO dataset (offline)
    baseProvider.js
    bookingComProvider.js   # RapidAPI Booking.com hotels
    data/airports.js
    hotelbedsProvider.js
    index.js                # registry; key-gated registration
    mockProvider.js         # demo data, auto-excluded per real vertical
    openSkyProvider.js
    skyScrapperProvider.js  # RapidAPI live Skyscanner flight prices
    travelpayoutsProvider.js
  routes/
    router.js
  utils/
    cache.js
    currency.js             # Frankfurter-backed conversion
    formatter.js
    geo.js                  # city name -> location code
    http.js
    httpClient.js           # audited outbound HTTP chokepoint
    priceHistory.js         # price memory: recording + vs-average stats
    rateLimit.js            # per-client token buckets
server.js
test/                       # unit, contract (fixtures/), and router tests
.env.example                # every supported variable, documented
```

## Installation

```bash
npm install
```

This project currently uses only Node.js built-in modules, so `npm install` does not need to download runtime dependencies.

## Run locally

```bash
cp .env.example .env   # optional: fill in any provider keys you have
npm start
```

The server defaults to `http://localhost:3000`. A `.env` file next to `server.js` is loaded
automatically (real environment variables always take precedence); with no keys set, the engine
runs on the demo + no-key providers. Add credentials to `.env` and restart; the matching real
providers register themselves and the demo stops serving those verticals.

## Test

```bash
npm test            # unit + contract tests
npm run coverage    # tests with line/branch coverage
npm run lint
npm run check       # lint + test
npm run smoke:live  # hit configured real providers once (needs keys + egress)
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

- **Per-client rate limiting**: each authenticated principal (or client IP) gets its own token
  bucket, so one abusive caller can't exhaust everyone's quota. Tracked keys are LRU-bounded.
- **Streaming response cap**: the shared HTTP client rejects oversized upstream bodies via
  `Content-Length` and incremental streaming, so a hostile provider can't OOM the process.
- **No secret leakage**: the authenticated principal is a one-way SHA-256 fingerprint (never key
  characters); logs redact `key|token|secret|password|authorization|signature|bearer|credential`
  fields; 5xx responses expose only `Unexpected error` with no internal details.
- **Bounded input**: every query parameter is length-capped and the parameter count is limited,
  keeping the request, cache key, and downstream serialization bounded.
- **Failure isolation**: per-provider timeouts + circuit breaker; a slow/failed provider is
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
| Sky-Scrapper (RapidAPI) | flights | `SKYSCRAPPER_RAPIDAPI_KEY` or `RAPIDAPI_KEY` | **Live** Skyscanner prices (all-in totals). Resolves the airport codes to Skyscanner ids automatically. |
| Booking.com (RapidAPI) | hotels | `BOOKINGCOM_RAPIDAPI_KEY` or `RAPIDAPI_KEY` | Live availability; all-in total = gross + excluded charges. Free-text `city`. |
| Booking.com cars (RapidAPI) | cars | `CARRENTAL_RAPIDAPI_KEY` or `RAPIDAPI_KEY` | Live car-rental "from" rates (marked `estimated`); resolves the city to pickup coordinates. |
| Hotelbeds APItude | hotels | `HOTELBEDS_API_KEY`, `HOTELBEDS_SECRET` | SHA256-signed; accepts `cityCode` or a resolvable `city`. `HOTELBEDS_ENV=test\|production`. |
| AeroDataBox (RapidAPI) | airports | `AERODATABOX_RAPIDAPI_KEY` or `RAPIDAPI_KEY` | Live airport detail enrichment. |
| Travelpayouts Data API | flights | `TRAVELPAYOUTS_TOKEN` (`TRAVELPAYOUTS_MARKER`) | Cached cheapest fares (7-day cache). |

Every priced offer now carries a `deepLink` (the booking handoff), with the affiliate marker
appended when one is configured, so a compared price is actually bookable. `RAPIDAPI_KEY` is a
shared fallback: one RapidAPI key unlocks every RapidAPI-hosted provider your account is subscribed
to (Sky-Scrapper, Booking.com, Booking.com cars, AeroDataBox). With Sky-Scrapper + Travelpayouts
configured, flights become a genuine multi-provider price race (live vs cached); with Booking.com +
Hotelbeds, hotels do too; and cars stop being demo-only.

> **Aviationstack** is intentionally not wired: its endpoints key on a flight *number*, not the
> `icao24` transponder hex the tracking vertical uses, so it cannot map cleanly to the current
> contract.

⚠️ **Network egress:** every external host (`opensky-network.org`, `api.adsb.lol`,
`api.airplanes.live`, `api.test.hotelbeds.com`, `aerodatabox.p.rapidapi.com`,
`sky-scrapper.p.rapidapi.com`, `booking-com15.p.rapidapi.com`,
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
