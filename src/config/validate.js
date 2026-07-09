const MIN_SECRET_LENGTH = 16;

export function productionReadiness(config) {
  const issues = [];
  if (config.nodeEnv !== 'production') {
    return { ok: true, issues };
  }

  if (config.accountsEnabled && !config.sessionSecret) {
    issues.push('SESSION_SECRET must be set in production');
  }

  if (!config.offerSigningSecret) {
    issues.push('OFFER_SIGNING_SECRET must be set in production');
  }

  const secrets = [
    ['SESSION_SECRET', config.sessionSecret],
    ['OFFER_SIGNING_SECRET', config.offerSigningSecret]
  ];
  for (const [name, value] of secrets) {
    if (value && value.length < MIN_SECRET_LENGTH) {
      issues.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }

  if (config.billingEnabled && config.stripeSecretKey && !config.stripeWebhookSecret) {
    issues.push('STRIPE_WEBHOOK_SECRET must be set when Stripe billing is live');
  }

  if (config.allowedOrigins.includes('*') && config.accountsEnabled) {
    issues.push('ALLOWED_ORIGINS must not be a wildcard when cookie sessions are enabled (CSRF risk)');
  }

  if (config.alertsWebhooksEnabled) {
    issues.push('ALERTS_WEBHOOKS_ENABLED in production requires an egress-restricted network (verify before enabling)');
  }

  return { ok: issues.length === 0, issues };
}

export function assertProductionReady(config) {
  const { ok, issues } = productionReadiness(config);
  if (!ok) {
    throw new Error('Unsafe production configuration: ' + issues.join('; '));
  }
}
