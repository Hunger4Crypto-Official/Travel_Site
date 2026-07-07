# Compliance and trust posture

How THE Travel Club is designed to stay on the right side of the failure patterns documented in
`docs/research/competitive-landscape.md` (FTC junk-fee rule, dark-patterns enforcement, membership
travel-club fraud record). This is an engineering posture document, not legal advice. Before taking
real payments or bookings, review it with counsel for your jurisdiction.

## 1. Pricing: all-in, upfront, no hidden fees

The FTC Junk Fees Rule (16 CFR Part 464, effective May 12, 2025) requires the total price with all
mandatory fees shown upfront for short-term lodging, explicitly including platforms that display
lodging prices. Our design goes further and applies it everywhere:

- Every search offer carries an all-in `price.total` (base + taxes + fees), or is explicitly marked
  `estimated`. Response-level `priceComparable` never overclaims.
- At booking, the trip total and the booking **service fee** are shown **separately** on the
  checkout sheet and stored on the order (`order.serviceFee`, `order.total`). The fee is never
  pre-selected, bundled, or revealed late. The top membership tier pays a zero fee.
- There are no drip charges: the number on the checkout sheet is the number charged.

## 2. No dark patterns

The FTC dark-patterns report and the Fareportal ($2.6M NY AG) and Hopper ($35M FTC) actions target
fabricated urgency and scarcity. Our contract has **no** countdown timers, "tickets left" counters,
"others viewing" numbers, or pre-checked add-ons anywhere in the API or UI. Ranking is cheapest
comparable total first and cannot be bought (`ranking.paidPlacement=false`).

## 3. Cancellation as easy as sign-up

FTC enforcement (ROSCA/Section 5; the $2.5B Amazon Prime settlement) targets "maze to cancel" flows.

- **Bookings:** `order.cancellationPolicy` is stated upfront on the checkout sheet, and a booking is
  cancelled with a single `DELETE /v1/orders/<id>` from the Trips tab. Any refund is returned and
  shown to the member.
- **Membership:** `POST /v1/billing/cancel` cancels and downgrades immediately, from the same
  Account screen where a member subscribed. No retention maze.

## 4. Membership travel-club red flags (avoided by design)

The FTC's standing red-flag list for vacation clubs: free-vacation lures into high-pressure
presentations, "act today" urgency, large upfront non-cancelable fees, and vague benefits.

- **No high-pressure sales, no prize-mailer funnels.** Sign-up is free and self-serve.
- **No large upfront deposit.** Membership is a transparent recurring subscription (Voyager,
  Globetrotter) that can be cancelled anytime; benefits are published as a concrete list.
- **Benefits are specific and honest:** waived booking fees (gold), loyalty multipliers, and the
  plumbing for genuine supplier closed-user-group rates. We do not advertise savings we cannot
  substantiate.

## 5. Merchant of record and PCI scope

The club uses a **managed-booking** model: the aggregator (Duffel for flights, a bedbank such as
Hotelbeds for hotels) is the merchant of record for the trip and carries ticketing, refund, and the
bulk of PCI liability. For membership subscriptions, **Stripe** is the merchant of record and card
data flows to Stripe, never through or into our storage.

- We store **no card numbers.** The only PII we hold is a member email and a `scrypt` password hash
  (per-user salt, `node:crypto`); the hash never appears in any API response.
- Webhooks are signature-verified (HMAC-SHA256 over the raw body with a timestamp tolerance) when a
  secret is configured.
- Outbound webhook delivery for price alerts is SSRF-guarded and off by default.
- **Before going live** you must still complete the applicable Stripe SAQ, confirm your merchant
  agreements, and check **Seller of Travel** registration (California, Florida, Washington, Hawaii
  and others require it for sellers of travel). The managed-booking model reduces but does not by
  itself eliminate these obligations.

## 6. AI is assistive only

The optional natural-language search assistant (local Ollama) is walled off from money and
compliance. It only proposes search fields, which pass a strict whitelist sanitizer and are then
validated by the deterministic engine. It never sets prices, ranks results, books, or produces any
compliance or eligibility text.

## 7. Red-team hardening (post-audit)

A multi-agent red-team pass plus live exploit drills against the running server found and closed a
set of real issues before any keys were deployed:

- **Offer integrity.** Search offers are HMAC-signed server-side (`OFFER_SIGNING_SECRET`); booking
  refuses any offer whose price was tampered with or that was fabricated, so loyalty points and the
  service fee cannot be forged from a client-supplied price.
- **Fail-closed webhooks.** The billing webhook refuses to apply anything unless a webhook secret is
  configured and the signature verifies, closing an unauthenticated tier-downgrade.
- **Rate limiting.** Signup/login are limited per IP (brute-force / event-loop-DoS guard) and the
  write/AI routes per principal; both return `429` with `Retry-After`.
- **No anonymous PII sharing.** Orders (passenger names, contact) require an authenticated caller;
  the shared `anonymous` owner can no longer read another person's booking.
- **Loyalty clawback.** Cancelling an order reverses its awarded points, so book-then-cancel cannot
  mint free credit.
- **Constant-time login.** Login runs the password hash even for unknown emails (decoy hash), so an
  attacker cannot enumerate accounts by timing.
- One reported finding (obfuscated-IP SSRF bypass) was **verified as already mitigated**: the URL
  parser canonicalizes numeric host encodings before the guard inspects them, so `isBlockedIpv4`
  already catches them. A regression test locks this in.

A follow-up pass then closed the remaining residuals:

- **Session revocation.** Sessions carry a per-user generation; logout (and, in future, a password
  change) bumps it, invalidating every previously issued token, not just the current cookie.
- **Non-blocking password hashing.** `scrypt` now runs asynchronously on the libuv thread pool, so a
  burst of signups/logins cannot pin the event loop (rate limiting is the first line; this is the
  second).
- **CSRF defense-in-depth.** A cross-origin mutating request that carries a session cookie is
  rejected (Origin allow-list / same-origin check), on top of the `SameSite=Lax` cookie.
- **Sandbox tier lockout.** In production the sandbox payment gateway can no longer grant a paid
  tier; a partially configured deployment refuses to hand out free memberships (`503`).

The single item that still needs external infrastructure is **email-verification-based
non-enumeration** (signup currently reveals whether an email is registered); it is mitigated by rate
limiting and requires an email provider to fully close.

## 8. Honest failures

When a data source fails we say so (`providers[].status` with a coarse error category and an
explicit message) instead of pretending there were no results. The published, machine-readable
commitments live at `GET /v1/trust`.
