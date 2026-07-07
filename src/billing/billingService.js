import { getTier } from '../accounts/membership.js';
import { publicUser } from '../accounts/accountService.js';

// Orchestrates membership billing over a payment gateway and the AccountStore.
// Subscribing to a paid tier upgrades the member; cancelling (or a cancellation
// webhook) downgrades them to free. The gateway is the merchant of record for
// the recurring charge; this service owns the member-tier side effects.
export class BillingService {
  constructor({ store, gateway, priceIds = {}, webhookSecret = null, requireLiveGateway = false } = {}) {
    this.store = store;
    this.gateway = gateway;
    this.priceIds = priceIds;
    this.webhookSecret = webhookSecret;
    // In production, never grant a paid tier through the sandbox gateway (a
    // partially configured deployment must not hand out free memberships).
    this.requireLiveGateway = requireLiveGateway;
  }

  async subscribe(user, tierId) {
    const tier = getTier(tierId);
    if (!tier || tier.id === 'free') {
      throw badRequest('Choose a paid membership tier (silver or gold)');
    }
    if (this.requireLiveGateway && !this.gateway.live) {
      const err = new Error('Billing is not fully configured on this deployment');
      err.statusCode = 503;
      throw err;
    }
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await this.gateway.createCustomer({ email: user.email, userId: user.id });
      customerId = customer.customerId;
    }
    const subscription = await this.gateway.createSubscription({
      customerId, priceId: this.priceIds[tierId] ?? null, tierId
    });
    const updated = this.store.update(user.id, {
      tier: tierId,
      stripeCustomerId: customerId,
      subscriptionId: subscription.subscriptionId,
      subscriptionStatus: subscription.status,
      subscriptionTier: tierId,
      subscriptionPeriodEnd: subscription.currentPeriodEnd
    });
    return { member: publicUser(updated), subscription: summarize(subscription) };
  }

  async cancel(user) {
    if (!user.subscriptionId) {
      throw badRequest('There is no active subscription to cancel');
    }
    const result = await this.gateway.cancelSubscription({ subscriptionId: user.subscriptionId });
    const updated = this.store.update(user.id, {
      tier: 'free',
      subscriptionStatus: result.status,
      subscriptionTier: null,
      subscriptionId: null,
      subscriptionPeriodEnd: null
    });
    return { member: publicUser(updated), subscription: { subscriptionId: result.subscriptionId, status: result.status } };
  }

  status(user) {
    return {
      tier: user.tier,
      subscriptionStatus: user.subscriptionStatus ?? null,
      subscriptionTier: user.subscriptionTier ?? null,
      periodEnd: user.subscriptionPeriodEnd ?? null,
      live: this.gateway.live
    };
  }

  // Verify, parse, and apply a gateway webhook. Fails CLOSED: with no configured
  // secret we cannot authenticate the sender, so we refuse to apply anything
  // rather than let an unauthenticated caller mutate a member's tier.
  handleWebhook(rawBody, signatureHeader) {
    if (!this.webhookSecret) {
      const err = new Error('Webhook signature verification is not configured');
      err.statusCode = 503;
      throw err;
    }
    const valid = this.gateway.verifyWebhookSignature({ payload: rawBody, signature: signatureHeader, secret: this.webhookSecret });
    if (!valid) throw unauthorized('Invalid webhook signature');
    return this.applyEvent(this.gateway.parseWebhookEvent(rawBody));
  }

  applyEvent(event) {
    const type = event?.type;
    const subscriptionId = event?.data?.object?.id;
    if (!subscriptionId) return { applied: false, reason: 'no subscription id' };
    const user = this.findBySubscription(subscriptionId);
    if (!user) return { applied: false, reason: 'no matching member' };

    if (type === 'customer.subscription.deleted') {
      this.store.update(user.id, { tier: 'free', subscriptionStatus: 'canceled', subscriptionTier: null, subscriptionId: null, subscriptionPeriodEnd: null });
      return { applied: true, action: 'downgraded', userId: user.id };
    }
    if (type === 'customer.subscription.updated') {
      this.store.update(user.id, { subscriptionStatus: event.data.object.status ?? user.subscriptionStatus });
      return { applied: true, action: 'status-synced', userId: user.id };
    }
    return { applied: false, reason: 'ignored event type' };
  }

  findBySubscription(subscriptionId) {
    for (const user of this.store.byId.values()) {
      if (user.subscriptionId === subscriptionId) return user;
    }
    return null;
  }
}

function summarize(subscription) {
  return {
    subscriptionId: subscription.subscriptionId,
    status: subscription.status,
    tier: subscription.tierId,
    periodEnd: subscription.currentPeriodEnd
  };
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function unauthorized(message) {
  const err = new Error(message);
  err.statusCode = 401;
  return err;
}
