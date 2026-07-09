// Postgres-backed transactional data layer.
//
// Shape mirrors src/billing/paymentGateway.js: a factory that takes an injected
// query function so it is trivially testable without a live database. The module
// imports node builtins only (randomUUID for id generation); the `pg` driver is
// never imported here. The caller wires up a real pool/client and passes a
// `query(sql, params) => Promise<{ rows }>` adapter that speaks Postgres-style
// positional params ($1, $2, ...).
//
// The returned stores mirror the in-memory AccountStore / OrderStore /
// LoyaltyLedger method surfaces and return the same camelCase object shapes, so
// a Postgres implementation drops in behind the same contracts. Client-facing
// strings avoid em dashes on purpose.
//
// transaction(fn) assumes the injected `query` represents a single connection
// for the duration of the callback, so BEGIN / COMMIT / ROLLBACK apply to the
// same session. The caller is responsible for handing a connection-bound query
// to createPostgresStores when transactional guarantees are required.

import { randomUUID } from 'node:crypto';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT,
  tier TEXT,
  role TEXT,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  token_generation INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT,
  subscription_id TEXT,
  subscription_status TEXT,
  subscription_tier TEXT,
  subscription_period_end BIGINT,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_key ON accounts (email);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  owner TEXT,
  type TEXT,
  status TEXT,
  data JSONB,
  created_at BIGINT,
  updated_at BIGINT
);

CREATE INDEX IF NOT EXISTS orders_owner_idx ON orders (owner);

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id TEXT PRIMARY KEY,
  owner TEXT,
  type TEXT,
  points INTEGER,
  reason TEXT,
  order_id TEXT,
  balance_after INTEGER,
  created_at BIGINT
);

CREATE INDEX IF NOT EXISTS loyalty_ledger_owner_idx ON loyalty_ledger (owner);
`;

const POSTGRES_UNIQUE_VIOLATION = '23505';

// Map an accounts row (snake_case columns) into the camelCase object shape the
// in-memory AccountStore returns.
function mapAccountRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    tier: row.tier,
    role: row.role,
    loyaltyPoints: row.loyalty_points,
    tokenGeneration: row.token_generation,
    stripeCustomerId: row.stripe_customer_id,
    subscriptionId: row.subscription_id,
    subscriptionStatus: row.subscription_status,
    subscriptionTier: row.subscription_tier,
    subscriptionPeriodEnd: row.subscription_period_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Reconstruct an order from its persisted `data` jsonb plus the promoted
// top-level columns, so the returned shape matches what was stored.
function mapOrderRow(row) {
  if (!row) return null;
  const data = row.data || {};
  return {
    ...data,
    id: row.id,
    owner: row.owner,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Map a loyalty_ledger row into the camelCase txn shape LoyaltyLedger returns.
// The ledger is append-only with no single-row lookup, so callers only ever
// hand this a real row (from RETURNING or a list); no null guard is needed.
function mapLedgerRow(row) {
  return {
    id: row.id,
    owner: row.owner,
    type: row.type,
    points: row.points,
    reason: row.reason,
    orderId: row.order_id,
    balanceAfter: row.balance_after,
    createdAt: row.created_at
  };
}

function conflict(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

// camelCase account patch key -> snake_case column. Unknown keys are ignored so
// callers cannot inject arbitrary columns, and id/email/createdAt stay immutable.
const ACCOUNT_UPDATE_COLUMNS = {
  passwordHash: 'password_hash',
  tier: 'tier',
  role: 'role',
  loyaltyPoints: 'loyalty_points',
  tokenGeneration: 'token_generation',
  stripeCustomerId: 'stripe_customer_id',
  subscriptionId: 'subscription_id',
  subscriptionStatus: 'subscription_status',
  subscriptionTier: 'subscription_tier',
  subscriptionPeriodEnd: 'subscription_period_end'
};

export function createPostgresStores({ query, now = () => Date.now(), idFactory = randomUUID }) {
  async function migrate() {
    await query(SCHEMA_SQL);
  }

  const accounts = {
    async create({ email, passwordHash, tier = 'free', role = 'member' }) {
      const timestamp = now();
      const id = idFactory();
      try {
        const { rows } = await query(
          `INSERT INTO accounts (
             id, email, password_hash, tier, role,
             loyalty_points, token_generation, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, 0, 0, $6, $6)
           RETURNING *`,
          [id, email, passwordHash, tier, role, timestamp]
        );
        return mapAccountRow(rows[0]);
      } catch (err) {
        if (err && err.code === POSTGRES_UNIQUE_VIOLATION) {
          throw conflict('An account with that email already exists');
        }
        throw err;
      }
    },

    async get(id) {
      const { rows } = await query('SELECT * FROM accounts WHERE id = $1', [id]);
      return mapAccountRow(rows[0]);
    },

    async findByEmail(email) {
      const { rows } = await query('SELECT * FROM accounts WHERE email = $1', [email]);
      return mapAccountRow(rows[0]);
    },

    async update(id, patch = {}) {
      const assignments = [];
      const params = [];
      for (const [key, column] of Object.entries(ACCOUNT_UPDATE_COLUMNS)) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) {
          params.push(patch[key]);
          assignments.push(`${column} = $${params.length}`);
        }
      }
      params.push(now());
      assignments.push(`updated_at = $${params.length}`);
      params.push(id);
      const { rows } = await query(
        `UPDATE accounts SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
      );
      return mapAccountRow(rows[0]);
    },

    async count() {
      const { rows } = await query('SELECT COUNT(*)::int AS count FROM accounts');
      return rows[0].count;
    }
  };

  const orders = {
    async create(order) {
      const timestamp = now();
      const id = idFactory();
      const { owner = null, type = null, status = null } = order || {};
      const { rows } = await query(
        `INSERT INTO orders (id, owner, type, status, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         RETURNING *`,
        [id, owner, type, status, order || {}, timestamp]
      );
      return mapOrderRow(rows[0]);
    },

    async get(id) {
      const { rows } = await query('SELECT * FROM orders WHERE id = $1', [id]);
      return mapOrderRow(rows[0]);
    },

    async list(owner) {
      const { rows } = await query(
        'SELECT * FROM orders WHERE owner = $1 ORDER BY created_at DESC',
        [owner]
      );
      return rows.map(mapOrderRow);
    },

    async update(id, patch = {}) {
      const { status = null, ...dataPatch } = patch;
      const timestamp = now();
      // Merge the patch into the existing jsonb via ||, promote status when the
      // patch carries it (COALESCE keeps the old value otherwise), and bump
      // updated_at. Returns null when no row matched.
      const { rows } = await query(
        `UPDATE orders
           SET data = COALESCE(data, '{}'::jsonb) || $2::jsonb,
               status = COALESCE($3, status),
               updated_at = $4
         WHERE id = $1
         RETURNING *`,
        [id, dataPatch, status, timestamp]
      );
      return mapOrderRow(rows[0]);
    },

    async count() {
      const { rows } = await query('SELECT COUNT(*)::int AS count FROM orders');
      return rows[0].count;
    }
  };

  const ledger = {
    async record({ owner, type, points, reason = null, orderId = null, balanceAfter }) {
      const timestamp = now();
      const id = idFactory();
      const { rows } = await query(
        `INSERT INTO loyalty_ledger (
           id, owner, type, points, reason, order_id, balance_after, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [id, owner, type, points, reason, orderId, balanceAfter, timestamp]
      );
      return mapLedgerRow(rows[0]);
    },

    async list(owner) {
      const { rows } = await query(
        'SELECT * FROM loyalty_ledger WHERE owner = $1 ORDER BY created_at DESC',
        [owner]
      );
      return rows.map(mapLedgerRow);
    },

    async count() {
      const { rows } = await query('SELECT COUNT(*)::int AS count FROM loyalty_ledger');
      return rows[0].count;
    }
  };

  async function transaction(fn) {
    await query('BEGIN');
    try {
      const result = await fn();
      await query('COMMIT');
      return result;
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }
  }

  return { accounts, orders, ledger, transaction, migrate };
}
