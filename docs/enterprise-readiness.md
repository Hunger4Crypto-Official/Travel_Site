# Enterprise readiness guide

THE Travel Club is still a provider-integration scaffold, but the service now includes the controls expected before real travel supplier credentials are connected.

## Security controls

- Keep `REQUIRE_API_KEY=true` in shared, staging, and production environments.
- Configure `API_KEYS` through a secrets manager, not source control.
- Configure `ALLOWED_ORIGINS` to trusted web properties; avoid `*` outside isolated development.
- `/health` is intentionally public and only reports liveness.
- `/ready` and `/metrics` are diagnostic endpoints and should be protected by API keys or infrastructure policy.
- Logs redact common secret-bearing fields such as keys, tokens, passwords, and authorization headers.

## Operations

- Use `/health` for liveness probes.
- Use `/ready` for readiness probes and provider diagnostics.
- Use `/metrics` for in-process counters and timing snapshots until an OpenTelemetry exporter is added.
- Tune `PROVIDER_TIMEOUT_MS`, `PROVIDER_FAILURE_THRESHOLD`, and `PROVIDER_COOLDOWN_MS` per provider SLA.
- Use a distributed cache and distributed rate limiter before running multiple replicas.

## Provider onboarding checklist

1. Confirm provider terms for caching, display order, affiliate attribution, and price freshness.
2. Keep provider keys in environment/secret management only.
3. Add a provider module extending `BaseProvider`.
4. Implement request cancellation with `AbortSignal` when the provider performs outbound HTTP calls.
5. Normalize final comparable prices, taxes, fees, currency, refundability, and cancellation rules.
6. Add unit tests for success, timeout, authentication failure, malformed provider payloads, and rate-limit errors.
7. Add contract tests against `docs/openapi.yaml` before publishing new response fields.

## Ranking governance

- `sort=price` means lowest known normalized price first.
- `sort=score` is reserved for best-value ranking and must document the scoring inputs before consumer launch.
- Sponsored placement must be clearly labeled and must not silently masquerade as cheapest.
- Affiliate payouts should be disclosed and should not override a user-selected cheapest sort.
