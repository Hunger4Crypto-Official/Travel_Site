import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionReadiness, assertProductionReady } from '../../src/config/validate.js';

function goodConfig(overrides = {}) {
  return {
    nodeEnv: 'production',
    accountsEnabled: true,
    sessionSecret: 'a-very-long-session-secret',
    offerSigningSecret: 'a-very-long-offer-secret',
    billingEnabled: true,
    stripeSecretKey: 'sk_live_example',
    stripeWebhookSecret: 'whsec_example',
    allowedOrigins: ['https://example.com'],
    alertsWebhooksEnabled: false,
    ...overrides
  };
}

test('non-production returns ok with no issues', () => {
  const result = productionReadiness({ nodeEnv: 'development' });
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('fully-configured production config returns ok:true', () => {
  const result = productionReadiness(goodConfig());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('missing SESSION_SECRET when accounts enabled triggers issue', () => {
  const result = productionReadiness(goodConfig({ sessionSecret: null }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('SESSION_SECRET must be set in production'));
});

test('missing session secret is not flagged when accounts disabled', () => {
  const result = productionReadiness(goodConfig({ accountsEnabled: false, sessionSecret: null }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('missing OFFER_SIGNING_SECRET triggers issue', () => {
  const result = productionReadiness(goodConfig({ offerSigningSecret: null }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('OFFER_SIGNING_SECRET must be set in production'));
});

test('short SESSION_SECRET triggers length issue', () => {
  const result = productionReadiness(goodConfig({ sessionSecret: 'short' }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('SESSION_SECRET must be at least 16 characters'));
});

test('short OFFER_SIGNING_SECRET triggers length issue', () => {
  const result = productionReadiness(goodConfig({ offerSigningSecret: 'short' }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('OFFER_SIGNING_SECRET must be at least 16 characters'));
});

test('missing STRIPE_WEBHOOK_SECRET when Stripe live triggers issue', () => {
  const result = productionReadiness(goodConfig({ stripeWebhookSecret: null }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('STRIPE_WEBHOOK_SECRET must be set when Stripe billing is live'));
});

test('stripe webhook not required when billing disabled', () => {
  const result = productionReadiness(goodConfig({ billingEnabled: false, stripeWebhookSecret: null }));
  assert.equal(result.ok, true);
});

test('stripe webhook not required when no stripe secret key', () => {
  const result = productionReadiness(goodConfig({ stripeSecretKey: null, stripeWebhookSecret: null }));
  assert.equal(result.ok, true);
});

test('wildcard origin with accounts enabled triggers CSRF issue', () => {
  const result = productionReadiness(goodConfig({ allowedOrigins: ['*'] }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('ALLOWED_ORIGINS must not be a wildcard when cookie sessions are enabled (CSRF risk)'));
});

test('wildcard origin without accounts is allowed', () => {
  const result = productionReadiness(goodConfig({ allowedOrigins: ['*'], accountsEnabled: false }));
  assert.equal(result.ok, true);
});

test('alerts webhooks enabled triggers hard requirement', () => {
  const result = productionReadiness(goodConfig({ alertsWebhooksEnabled: true }));
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes('ALERTS_WEBHOOKS_ENABLED in production requires an egress-restricted network (verify before enabling)'));
});

test('assertProductionReady throws on bad config', () => {
  assert.throws(
    () => assertProductionReady(goodConfig({ offerSigningSecret: null })),
    /Unsafe production configuration: OFFER_SIGNING_SECRET must be set in production/
  );
});

test('assertProductionReady does not throw on good config', () => {
  assert.doesNotThrow(() => assertProductionReady(goodConfig()));
});
