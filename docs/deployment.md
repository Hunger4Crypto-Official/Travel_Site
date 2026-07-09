# Deployment Runbook

Production operations guide for THE Travel Club API server. The app is a
zero-dependency Node.js 22 ESM HTTP server. It boots with demo and no-key
providers when nothing is configured, so most settings below harden a real
deployment rather than being strictly required to start.

## 1. Required environment and secrets

Set stable, long, random values for every signing secret. If a secret is unset
the app falls back to an ephemeral value, which silently invalidates sessions
and in-flight offers on every restart.

| Variable | Purpose |
| --- | --- |
| `SESSION_SECRET` | Signs stateless session cookies. Must be stable across restarts and identical on every instance, or logins break. |
| `OFFER_SIGNING_SECRET` | Signs bookable search offers so a client cannot tamper with a price or fabricate an offer at checkout. Must be stable and shared across instances. |
| `STRIPE_SECRET_KEY` | Stripe merchant key (`sk_live_...`) for membership billing. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`; when set, incoming Stripe webhook signatures are verified. Set this in production so webhooks cannot be forged. |
| `STRIPE_PRICE_SILVER` / `STRIPE_PRICE_GOLD` | Stripe Price ids for the membership tiers. |
| `DUFFEL_TOKEN` | Flight booking credential (Duffel). Sandbox until set. |
| `HOTELBEDS_API_KEY` / `HOTELBEDS_SECRET` | Hotel content and booking credentials. Sandbox until set. |
| `API_KEYS` | Comma-separated consumer/ops API keys. Presence enables required auth automatically in production. |
| `ALLOWED_ORIGINS` | Explicit CORS allowlist. Use concrete origins (`https://app.example.com`), never `*`. |
| `TRUST_PROXY_HOPS` | Number of trusted proxy hops in front of the app. Controls how X-Forwarded-For is interpreted for client IP. |

Provider keys (RapidAPI, Travelpayouts, etc.) are optional and only enable the
corresponding upstream. See `.env.example` for the full catalog.

Store secrets in your platform's secret manager. Do not bake them into the
image or commit a real `.env`.

## 2. TLS and HSTS at the proxy

Terminate TLS at a reverse proxy in front of the app (nginx, Caddy, an ALB).
The app itself speaks plain HTTP inside the trusted network.

- Enforce TLS 1.2+ and redirect HTTP to HTTPS at the proxy.
- Send `Strict-Transport-Security` (HSTS) with a long `max-age` and
  `includeSubDomains` from the proxy.
- Set `COOKIE_SECURE=true` (it is always on when `NODE_ENV=production`) so
  session cookies are only sent over HTTPS.

## 3. Trusted-proxy X-Forwarded-For handling

Per-IP rate limits and abuse controls depend on the real client IP.

- The proxy MUST overwrite (not append to) `X-Forwarded-For` with the real
  client address so a client cannot spoof it and bypass per-IP limits.
- Set `TRUST_PROXY_HOPS` to match exactly how many trusted proxies sit in
  front of the app. Too high lets clients spoof; too low reads the wrong IP.
- Never expose the app port directly to the public internet; only the trusted
  proxy should reach it.

## 4. Single-instance alert-sweep caveat

The background price-alert sweep (`ALERTS_CHECK_INTERVAL_MS`) runs inside the
app process. If you run multiple app instances, ONLY ONE should run the sweep,
otherwise alerts are checked and notifications delivered N times.

- Run the sweep on a single dedicated instance (or a separate worker), and set
  `ALERTS_CHECK_INTERVAL_MS=0` (or `ALERTS_ENABLED=false`) on all other
  instances to disable it there.
- Rate limiting is currently in-process as well; a shared Redis-backed limiter
  (see `docker-compose.yml` `redis` service) is the path to consistent limits
  across instances.

## 5. Postgres backups and tested restore

- Take automated, scheduled backups (managed snapshots or `pg_dump`) and ship
  them off-host to durable storage.
- Encrypt backups at rest and enforce a retention policy.
- Regularly perform a TEST RESTORE into a scratch database and verify the data.
  A backup you have never restored is not a backup.
- Persist the `postgres-data` volume; never store the only copy on ephemeral
  container storage.

## 6. Health and readiness probes

- `GET /health` - liveness. Use for the container HEALTHCHECK and the
  orchestrator liveness probe. A failing `/health` should restart the container.
- `GET /ready` - readiness. Use for the load-balancer / orchestrator readiness
  gate so traffic only routes to instances able to serve.
- During rolling deploys, wait for `/ready` before shifting traffic to a new
  instance and before terminating an old one.

## 7. Container and runtime hardening

- The image runs as the non-root `node` user. Keep it that way; do not add
  `USER root` at the end of a derived image.
- Set resource limits (CPU and memory) on every instance so a single container
  cannot starve its host. In compose use `deploy.resources.limits`; in
  Kubernetes set `requests` and `limits`.
- Run the container read-only where possible; the only writable path the app
  may need is `./data` for optional JSONL stores (or use Postgres instead).

## 8. Rolling deploy and rollback

- Deploy with a rolling strategy: bring up new instances, wait for `/ready`,
  drain and stop old ones. Honor SIGTERM/SIGINT; the app closes the server and
  clears the alert timer on shutdown for a clean drain.
- Keep the previous image tag available and pin deployments to immutable tags
  (a digest or a version), never a moving `latest`.
- Rollback = redeploy the previous known-good image tag. Because sessions and
  offers are signed with stable secrets, a rollback does not invalidate them as
  long as the secrets are unchanged.
- Apply database migrations in a backward-compatible order (expand, deploy,
  contract) so a rollback does not hit an incompatible schema.

## 9. Secret rotation

- Rotate `SESSION_SECRET`, `OFFER_SIGNING_SECRET`, Stripe keys, and provider
  credentials on a schedule and immediately on any suspected exposure.
- Rotating `SESSION_SECRET` invalidates existing sessions (users re-login);
  rotating `OFFER_SIGNING_SECRET` invalidates in-flight offers (clients
  re-search). Prefer rotating during low traffic.
- Rotate provider and Stripe keys by provisioning the new value, deploying it,
  then revoking the old value at the provider once no instance uses it.
- Never log secrets and never commit them. Scope each ops `API_KEY` narrowly so
  a single leaked key can be revoked without disrupting others.
