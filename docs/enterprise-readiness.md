# Enterprise readiness guide

THE Travel Club ships with real no-key providers (airport reference data, OpenSky/ADS-B tracking),
key-gated real providers (Sky-Scrapper flights, Booking.com + Hotelbeds hotels, AeroDataBox,
Travelpayouts), and the
controls expected before production traffic: per-client rate limiting, provider circuit breakers and
timeouts, an audited outbound HTTP chokepoint with response-size caps, all-in price normalization,
cross-provider de-duplication, and contract tests for every provider mapping.

## Security controls

- Keep `REQUIRE_API_KEY=true` in shared, staging, and production environments.
- Configure `API_KEYS` through a secrets manager, not source control. `.env` is git-ignored and
  loaded automatically for local development only; real environment variables always win.
- Configure `ALLOWED_ORIGINS` to trusted web properties; avoid `*` outside isolated development.
- `/health` is intentionally public and only reports liveness.
- `/ready` and `/metrics` are diagnostic endpoints and are automatically key-protected whenever
  `API_KEYS` is configured.
- Logs redact common secret-bearing fields such as keys, tokens, passwords, and authorization headers.
- Consumer API keys are compared with a timing-safe equality check.
- Rate limiting is per client (API-key principal, else IP) with LRU-bounded bucket tracking.

## Operations

- Use `/health` for liveness probes.
- Use `/ready` for readiness probes and provider diagnostics.
- Use `/metrics` for in-process counters and timing snapshots until an OpenTelemetry exporter is added.
- Tune `PROVIDER_TIMEOUT_MS`, `PROVIDER_FAILURE_THRESHOLD`, and `PROVIDER_COOLDOWN_MS` per provider SLA.
- Use a distributed cache and distributed rate limiter before running multiple replicas.

## Provider onboarding checklist

1. Confirm provider terms for caching, display order, affiliate attribution, and price freshness.
2. Keep provider keys in environment/secret management only (locally: `.env`, never committed).
3. Add a provider module extending `BaseProvider`; route all outbound HTTP through
   `src/utils/httpClient.js` (timeouts, size caps, and error shaping come for free).
4. Emit the all-in price shape `{ amount, total, base, currency, estimated }` and an honest
   `freshness` (`live` or `cached`) so comparability reporting stays truthful.
5. Add unit tests for success, timeout, authentication failure, malformed provider payloads, and
   rate-limit errors, plus a recorded fixture in `test/fixtures/` with a contract test.
6. Prove the mapping against the live API with `npm run smoke:live` before enabling in production.

## Ranking governance

- `sort=price` means lowest known normalized price first.
- `sort=score` is reserved for best-value ranking and must document the scoring inputs before consumer launch.
- Sponsored placement must be clearly labeled and must not silently masquerade as cheapest.
- Affiliate payouts should be disclosed and should not override a user-selected cheapest sort.
