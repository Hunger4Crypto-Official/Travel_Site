import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA_SQL, createPostgresStores } from '../../src/data/postgresStores.js';

// A fake single-connection query client. It records every (sql, params) call and
// returns canned `{ rows }` responses. Responses are supplied either as a queue
// (consumed FIFO) or as a matcher function keyed on the SQL text. This mirrors
// how paymentGateway tests inject a fake fetchJson: no real database involved.
function makeFakeQuery({ responder } = {}) {
  const calls = [];
  async function query(sql, params) {
    calls.push({ sql, params });
    const result = responder ? responder(sql, params) : undefined;
    if (result instanceof Error) throw result;
    return result || { rows: [] };
  }
  query.calls = calls;
  // Convenience: the trimmed first keyword-ish fragment for assertions.
  query.sqlAt = (i) => calls[i].sql;
  query.paramsAt = (i) => calls[i].params;
  return query;
}

function makeStores(responder, overrides = {}) {
  const query = makeFakeQuery({ responder });
  const stores = createPostgresStores({
    query,
    now: () => 1000,
    idFactory: () => 'fixed-id',
    ...overrides
  });
  return { query, stores };
}

const ACCOUNT_ROW = {
  id: 'fixed-id',
  email: 'a@b.com',
  password_hash: 'hash',
  tier: 'free',
  role: 'member',
  loyalty_points: 5,
  token_generation: 2,
  stripe_customer_id: 'cus_1',
  subscription_id: 'sub_1',
  subscription_status: 'active',
  subscription_tier: 'pro',
  subscription_period_end: 9999,
  created_at: 1000,
  updated_at: 1000
};

test('SCHEMA_SQL declares the three tables and their indexes', () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS accounts/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS orders/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS loyalty_ledger/);
  assert.match(SCHEMA_SQL, /CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_key/);
  assert.match(SCHEMA_SQL, /CREATE INDEX IF NOT EXISTS orders_owner_idx/);
  assert.match(SCHEMA_SQL, /CREATE INDEX IF NOT EXISTS loyalty_ledger_owner_idx/);
  assert.doesNotMatch(SCHEMA_SQL, /—/); // no em dashes
});

test('migrate runs SCHEMA_SQL', async () => {
  const { query, stores } = makeStores(() => ({ rows: [] }));
  await stores.migrate();
  assert.equal(query.calls.length, 1);
  assert.equal(query.sqlAt(0), SCHEMA_SQL);
});

test('accounts.create issues an INSERT and maps the row', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /INSERT INTO accounts/);
    return { rows: [ACCOUNT_ROW] };
  });
  const account = await stores.accounts.create({ email: 'a@b.com', passwordHash: 'hash' });
  assert.deepEqual(account, {
    id: 'fixed-id',
    email: 'a@b.com',
    passwordHash: 'hash',
    tier: 'free',
    role: 'member',
    loyaltyPoints: 5,
    tokenGeneration: 2,
    stripeCustomerId: 'cus_1',
    subscriptionId: 'sub_1',
    subscriptionStatus: 'active',
    subscriptionTier: 'pro',
    subscriptionPeriodEnd: 9999,
    createdAt: 1000,
    updatedAt: 1000
  });
  // Defaults tier='free', role='member' land in params.
  assert.deepEqual(query.paramsAt(0), ['fixed-id', 'a@b.com', 'hash', 'free', 'member', 1000]);
});

test('accounts.create passes through explicit tier and role', async () => {
  const { query, stores } = makeStores(() => ({ rows: [ACCOUNT_ROW] }));
  await stores.accounts.create({ email: 'a@b.com', passwordHash: 'h', tier: 'gold', role: 'admin' });
  assert.deepEqual(query.paramsAt(0), ['fixed-id', 'a@b.com', 'h', 'gold', 'admin', 1000]);
});

test('accounts.create maps a unique-violation to statusCode 409', async () => {
  const dbErr = new Error('duplicate key value violates unique constraint');
  dbErr.code = '23505';
  const { stores } = makeStores(() => dbErr);
  await assert.rejects(
    () => stores.accounts.create({ email: 'a@b.com', passwordHash: 'h' }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already exists/);
      assert.doesNotMatch(err.message, /—/);
      return true;
    }
  );
});

test('accounts.create propagates non-unique DB errors', async () => {
  const dbErr = new Error('connection reset');
  dbErr.code = '08006';
  const { stores } = makeStores(() => dbErr);
  await assert.rejects(
    () => stores.accounts.create({ email: 'a@b.com', passwordHash: 'h' }),
    (err) => {
      assert.equal(err.statusCode, undefined);
      assert.match(err.message, /connection reset/);
      return true;
    }
  );
});

test('accounts.create propagates errors that lack a code', async () => {
  const { stores } = makeStores(() => new Error('boom'));
  await assert.rejects(
    () => stores.accounts.create({ email: 'a@b.com', passwordHash: 'h' }),
    /boom/
  );
});

test('accounts.get maps a hit and returns null on a miss', async () => {
  const hit = makeStores((sql) => {
    assert.match(sql, /SELECT \* FROM accounts WHERE id = \$1/);
    return { rows: [ACCOUNT_ROW] };
  });
  const account = await hit.stores.accounts.get('fixed-id');
  assert.equal(account.id, 'fixed-id');
  assert.deepEqual(hit.query.paramsAt(0), ['fixed-id']);

  const miss = makeStores(() => ({ rows: [] }));
  assert.equal(await miss.stores.accounts.get('nope'), null);
});

test('accounts.findByEmail maps a hit and returns null on a miss', async () => {
  const hit = makeStores((sql) => {
    assert.match(sql, /SELECT \* FROM accounts WHERE email = \$1/);
    return { rows: [ACCOUNT_ROW] };
  });
  const account = await hit.stores.accounts.findByEmail('a@b.com');
  assert.equal(account.email, 'a@b.com');
  assert.deepEqual(hit.query.paramsAt(0), ['a@b.com']);

  const miss = makeStores(() => ({ rows: [] }));
  assert.equal(await miss.stores.accounts.findByEmail('nope@b.com'), null);
});

test('accounts.update builds a dynamic SET, snake_cases fields, ignores unknown keys', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /UPDATE accounts SET/);
    return { rows: [ACCOUNT_ROW] };
  });
  const result = await stores.accounts.update('fixed-id', {
    loyaltyPoints: 5,
    tokenGeneration: 2,
    stripeCustomerId: 'cus_1',
    subscriptionId: 'sub_1',
    subscriptionStatus: 'active',
    subscriptionTier: 'pro',
    subscriptionPeriodEnd: 9999,
    passwordHash: 'newhash',
    tier: 'gold',
    role: 'admin',
    bogusKey: 'ignore-me',
    id: 'should-not-move',
    email: 'should-not-change'
  });
  // SET clause order follows the known-column map, not patch insertion order.
  const sql = query.sqlAt(0);
  assert.match(sql, /password_hash = \$1/);
  assert.match(sql, /tier = \$2/);
  assert.match(sql, /role = \$3/);
  assert.match(sql, /loyalty_points = \$4/);
  assert.match(sql, /token_generation = \$5/);
  assert.match(sql, /stripe_customer_id = \$6/);
  assert.match(sql, /subscription_id = \$7/);
  assert.match(sql, /subscription_status = \$8/);
  assert.match(sql, /subscription_tier = \$9/);
  assert.match(sql, /subscription_period_end = \$10/);
  assert.match(sql, /updated_at = \$11/);
  assert.match(sql, /WHERE id = \$12/);
  // Unknown/immutable keys never reach the SQL.
  assert.doesNotMatch(sql, /bogus/);
  assert.doesNotMatch(sql, /email/);
  const params = query.paramsAt(0);
  assert.deepEqual(params, ['newhash', 'gold', 'admin', 5, 2, 'cus_1', 'sub_1', 'active', 'pro', 9999, 1000, 'fixed-id']);
  assert.equal(result.id, 'fixed-id');
});

test('accounts.update with an empty patch still bumps updated_at', async () => {
  const { query, stores } = makeStores(() => ({ rows: [ACCOUNT_ROW] }));
  await stores.accounts.update('fixed-id');
  const sql = query.sqlAt(0);
  assert.match(sql, /UPDATE accounts SET updated_at = \$1 WHERE id = \$2/);
  assert.deepEqual(query.paramsAt(0), [1000, 'fixed-id']);
});

test('accounts.update returns null when no row matched', async () => {
  const { stores } = makeStores(() => ({ rows: [] }));
  assert.equal(await stores.accounts.update('missing', { tier: 'gold' }), null);
});

test('accounts.count returns the integer count', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /SELECT COUNT\(\*\)::int AS count FROM accounts/);
    return { rows: [{ count: 7 }] };
  });
  assert.equal(await stores.accounts.count(), 7);
});

const ORDER_ROW = {
  id: 'fixed-id',
  owner: 'user-1',
  type: 'flight',
  status: 'pending',
  data: { owner: 'user-1', type: 'flight', status: 'pending', amount: 200, currency: 'usd' },
  created_at: 1000,
  updated_at: 1000
};

test('orders.create stores the order object and reconstructs the merged shape', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /INSERT INTO orders/);
    return { rows: [ORDER_ROW] };
  });
  const order = await stores.orders.create({ owner: 'user-1', type: 'flight', status: 'pending', amount: 200, currency: 'usd' });
  assert.deepEqual(order, {
    owner: 'user-1',
    type: 'flight',
    status: 'pending',
    amount: 200,
    currency: 'usd',
    id: 'fixed-id',
    createdAt: 1000,
    updatedAt: 1000
  });
  const params = query.paramsAt(0);
  assert.equal(params[0], 'fixed-id');
  assert.equal(params[1], 'user-1');
  assert.equal(params[2], 'flight');
  assert.equal(params[3], 'pending');
  assert.deepEqual(params[4], { owner: 'user-1', type: 'flight', status: 'pending', amount: 200, currency: 'usd' });
  assert.equal(params[5], 1000);
});

test('orders.create tolerates an order with no owner/type/status', async () => {
  const { query, stores } = makeStores(() => ({
    rows: [{ id: 'fixed-id', owner: null, type: null, status: null, data: {}, created_at: 1000, updated_at: 1000 }]
  }));
  const order = await stores.orders.create();
  assert.deepEqual(query.paramsAt(0), ['fixed-id', null, null, null, {}, 1000]);
  assert.deepEqual(order, { id: 'fixed-id', owner: null, type: null, status: null, createdAt: 1000, updatedAt: 1000 });
});

test('orders.create handles a row whose data column is null', async () => {
  const { stores } = makeStores(() => ({
    rows: [{ id: 'fixed-id', owner: 'u', type: 't', status: 's', data: null, created_at: 1000, updated_at: 1000 }]
  }));
  const order = await stores.orders.create({ owner: 'u', type: 't', status: 's' });
  assert.deepEqual(order, { id: 'fixed-id', owner: 'u', type: 't', status: 's', createdAt: 1000, updatedAt: 1000 });
});

test('orders.get maps a hit and returns null on a miss', async () => {
  const hit = makeStores((sql) => {
    assert.match(sql, /SELECT \* FROM orders WHERE id = \$1/);
    return { rows: [ORDER_ROW] };
  });
  const order = await hit.stores.orders.get('fixed-id');
  assert.equal(order.amount, 200);
  assert.deepEqual(hit.query.paramsAt(0), ['fixed-id']);

  const miss = makeStores(() => ({ rows: [] }));
  assert.equal(await miss.stores.orders.get('nope'), null);
});

test('orders.list orders by created_at DESC and reconstructs each row', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /ORDER BY created_at DESC/);
    return { rows: [ORDER_ROW, { ...ORDER_ROW, id: 'second', data: { note: 'x' } }] };
  });
  const list = await stores.orders.list('user-1');
  assert.equal(list.length, 2);
  assert.equal(list[0].amount, 200);
  assert.equal(list[1].id, 'second');
  assert.equal(list[1].note, 'x');
  assert.deepEqual(query.paramsAt(0), ['user-1']);
});

test('orders.update merges data jsonb, promotes status, bumps updated_at', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /UPDATE orders/);
    assert.match(sql, /data = COALESCE\(data, '\{\}'::jsonb\) \|\| \$2::jsonb/);
    return { rows: [{ ...ORDER_ROW, status: 'confirmed', updated_at: 2000 }] };
  });
  const updated = await stores.orders.update('fixed-id', { status: 'confirmed', confirmation: 'ABC' });
  assert.equal(updated.status, 'confirmed');
  const params = query.paramsAt(0);
  assert.equal(params[0], 'fixed-id');
  assert.deepEqual(params[1], { confirmation: 'ABC' });
  assert.equal(params[2], 'confirmed');
  assert.equal(params[3], 1000);
});

test('orders.update with no status passes null for the status param', async () => {
  const { query, stores } = makeStores(() => ({ rows: [ORDER_ROW] }));
  await stores.orders.update('fixed-id', { note: 'y' });
  const params = query.paramsAt(0);
  assert.deepEqual(params[1], { note: 'y' });
  assert.equal(params[2], null);
});

test('orders.update with an empty patch merges an empty object', async () => {
  const { query, stores } = makeStores(() => ({ rows: [ORDER_ROW] }));
  await stores.orders.update('fixed-id');
  assert.deepEqual(query.paramsAt(0)[1], {});
});

test('orders.update returns null when no row matched', async () => {
  const { stores } = makeStores(() => ({ rows: [] }));
  assert.equal(await stores.orders.update('missing', { status: 'x' }), null);
});

test('orders.count returns the integer count', async () => {
  const { stores } = makeStores(() => ({ rows: [{ count: 3 }] }));
  assert.equal(await stores.orders.count(), 3);
});

const LEDGER_ROW = {
  id: 'fixed-id',
  owner: 'user-1',
  type: 'earn',
  points: 50,
  reason: 'booking',
  order_id: 'order-9',
  balance_after: 150,
  created_at: 1000
};

test('ledger.record inserts and maps the row', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /INSERT INTO loyalty_ledger/);
    return { rows: [LEDGER_ROW] };
  });
  const txn = await stores.ledger.record({
    owner: 'user-1',
    type: 'earn',
    points: 50,
    reason: 'booking',
    orderId: 'order-9',
    balanceAfter: 150
  });
  assert.deepEqual(txn, {
    id: 'fixed-id',
    owner: 'user-1',
    type: 'earn',
    points: 50,
    reason: 'booking',
    orderId: 'order-9',
    balanceAfter: 150,
    createdAt: 1000
  });
  assert.deepEqual(query.paramsAt(0), ['fixed-id', 'user-1', 'earn', 50, 'booking', 'order-9', 150, 1000]);
});

test('ledger.record defaults reason and orderId to null', async () => {
  const { query, stores } = makeStores(() => ({
    rows: [{ ...LEDGER_ROW, reason: null, order_id: null }]
  }));
  const txn = await stores.ledger.record({ owner: 'user-1', type: 'redeem', points: -20, balanceAfter: 130 });
  assert.equal(txn.reason, null);
  assert.equal(txn.orderId, null);
  assert.deepEqual(query.paramsAt(0), ['fixed-id', 'user-1', 'redeem', -20, null, null, 130, 1000]);
});

test('ledger.list orders by created_at DESC and maps rows', async () => {
  const { query, stores } = makeStores((sql) => {
    assert.match(sql, /SELECT \* FROM loyalty_ledger WHERE owner = \$1 ORDER BY created_at DESC/);
    return { rows: [LEDGER_ROW, { ...LEDGER_ROW, id: 'second' }] };
  });
  const list = await stores.ledger.list('user-1');
  assert.equal(list.length, 2);
  assert.equal(list[0].points, 50);
  assert.equal(list[1].id, 'second');
  assert.deepEqual(query.paramsAt(0), ['user-1']);
});

test('ledger.count returns the integer count', async () => {
  const { stores } = makeStores(() => ({ rows: [{ count: 9 }] }));
  assert.equal(await stores.ledger.count(), 9);
});

test('transaction emits BEGIN then COMMIT and returns the callback result', async () => {
  const { query, stores } = makeStores(() => ({ rows: [{ count: 0 }] }));
  const result = await stores.transaction(async () => {
    await stores.accounts.count();
    return 'done';
  });
  assert.equal(result, 'done');
  assert.equal(query.sqlAt(0), 'BEGIN');
  assert.match(query.sqlAt(1), /COUNT/);
  assert.equal(query.sqlAt(2), 'COMMIT');
});

test('transaction emits ROLLBACK and rethrows when the callback throws', async () => {
  const { query, stores } = makeStores(() => ({ rows: [] }));
  const boom = new Error('callback failed');
  await assert.rejects(
    () => stores.transaction(async () => { throw boom; }),
    /callback failed/
  );
  assert.equal(query.sqlAt(0), 'BEGIN');
  assert.equal(query.sqlAt(1), 'ROLLBACK');
  assert.equal(query.calls.length, 2);
});

test('factory falls back to Date.now and randomUUID defaults', async () => {
  // Exercise the default parameter bindings (now, idFactory) without stubs.
  const query = makeFakeQuery({ responder: () => ({ rows: [ACCOUNT_ROW] }) });
  const stores = createPostgresStores({ query });
  await stores.accounts.create({ email: 'a@b.com', passwordHash: 'h' });
  const params = query.paramsAt(0);
  assert.equal(typeof params[0], 'string'); // randomUUID id
  assert.equal(typeof params[5], 'number'); // Date.now timestamp
});
