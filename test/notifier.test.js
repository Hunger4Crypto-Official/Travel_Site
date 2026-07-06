import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAllowedWebhookUrl,
  parseIpv4,
  isBlockedIpv4,
  isBlockedIpv6,
  createNotifier
} from '../src/utils/notifier.js';
import { stubFetch, jsonResponse, rejectingFetch } from './helpers/fakeFetch.js';

test('parseIpv4 accepts canonical dotted quads and rejects everything else', () => {
  assert.deepEqual(parseIpv4('1.2.3.4'), [1, 2, 3, 4]);
  assert.deepEqual(parseIpv4('255.255.255.255'), [255, 255, 255, 255]);
  assert.equal(parseIpv4('256.0.0.1'), null); // octet out of range
  assert.equal(parseIpv4('1.2.3'), null); // too few octets
  assert.equal(parseIpv4('1.2.3.4.5'), null); // too many octets
  assert.equal(parseIpv4('a.b.c.d'), null); // non-numeric
  assert.equal(parseIpv4('1.2.3.04a'), null); // non-digit char
  assert.equal(parseIpv4(42), null); // non-string
});

test('isBlockedIpv4 covers each private/loopback/link-local range and passes public IPs', () => {
  assert.equal(isBlockedIpv4('0.0.0.0'), true);
  assert.equal(isBlockedIpv4('127.0.0.1'), true);
  assert.equal(isBlockedIpv4('10.1.2.3'), true);
  assert.equal(isBlockedIpv4('172.16.0.1'), true);
  assert.equal(isBlockedIpv4('172.31.255.255'), true);
  assert.equal(isBlockedIpv4('192.168.1.1'), true);
  assert.equal(isBlockedIpv4('169.254.169.254'), true); // cloud metadata
  // Boundaries that must NOT be blocked.
  assert.equal(isBlockedIpv4('172.15.0.1'), false);
  assert.equal(isBlockedIpv4('172.32.0.1'), false);
  assert.equal(isBlockedIpv4('8.8.8.8'), false);
  assert.equal(isBlockedIpv4('not-an-ip'), false); // parse fails -> not blocked here
});

test('isBlockedIpv6 covers loopback/unspecified/unique-local/link-local', () => {
  assert.equal(isBlockedIpv6('::1'), true);
  assert.equal(isBlockedIpv6('::'), true);
  assert.equal(isBlockedIpv6('fc00::1'), true);
  assert.equal(isBlockedIpv6('fd12:3456::1'), true);
  assert.equal(isBlockedIpv6('fe80::1'), true);
  assert.equal(isBlockedIpv6('feba::1'), true);
  assert.equal(isBlockedIpv6('2001:4860:4860::8888'), false); // public
  assert.equal(isBlockedIpv6('not-ipv6'), false); // no colon
  assert.equal(isBlockedIpv6(123), false); // non-string
});

test('isAllowedWebhookUrl allows public http/https URLs', () => {
  assert.equal(isAllowedWebhookUrl('http://example.com/hook'), true);
  assert.equal(isAllowedWebhookUrl('https://hooks.slack.com/services/x'), true);
  assert.equal(isAllowedWebhookUrl('http://8.8.8.8/hook'), true); // public IPv4
  assert.equal(isAllowedWebhookUrl('http://[2001:4860:4860::8888]/x'), true); // public IPv6
});

test('isAllowedWebhookUrl blocks non-http(s) protocols', () => {
  assert.equal(isAllowedWebhookUrl('ftp://example.com/x'), false);
  assert.equal(isAllowedWebhookUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedWebhookUrl('javascript:alert(1)'), false);
});

test('isAllowedWebhookUrl blocks localhost and .localhost', () => {
  assert.equal(isAllowedWebhookUrl('http://localhost/x'), false);
  assert.equal(isAllowedWebhookUrl('http://LOCALHOST:8080/x'), false);
  assert.equal(isAllowedWebhookUrl('http://api.localhost/x'), false);
});

test('isAllowedWebhookUrl blocks private/loopback/link-local IPv4 literals', () => {
  assert.equal(isAllowedWebhookUrl('http://127.0.0.1:9000/x'), false);
  assert.equal(isAllowedWebhookUrl('http://10.0.0.5/x'), false);
  assert.equal(isAllowedWebhookUrl('http://172.16.5.5/x'), false);
  assert.equal(isAllowedWebhookUrl('http://192.168.0.1/x'), false);
  assert.equal(isAllowedWebhookUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isAllowedWebhookUrl('http://0.0.0.0/x'), false);
  // 172.16/12 boundary: .32 is public and allowed.
  assert.equal(isAllowedWebhookUrl('http://172.32.0.1/x'), true);
});

test('isAllowedWebhookUrl blocks bracketed IPv6 loopback/private/link-local', () => {
  assert.equal(isAllowedWebhookUrl('http://[::1]:9000/'), false);
  assert.equal(isAllowedWebhookUrl('http://[::]/'), false);
  assert.equal(isAllowedWebhookUrl('http://[fc00::1]/'), false);
  assert.equal(isAllowedWebhookUrl('http://[fd12::1]/'), false);
  assert.equal(isAllowedWebhookUrl('http://[fe80::1]/'), false);
});

test('isAllowedWebhookUrl returns false for malformed URLs', () => {
  assert.equal(isAllowedWebhookUrl('not a url'), false);
  assert.equal(isAllowedWebhookUrl(''), false);
  assert.equal(isAllowedWebhookUrl(null), false);
});

test('notifier disabled returns disabled without any network call', async () => {
  const fetchImpl = stubFetch(jsonResponse({ ok: true }));
  const notifier = createNotifier({ fetchImpl, enabled: false });
  const res = await notifier.notify('https://example.com/x', { a: 1 });
  assert.deepEqual(res, { delivered: false, reason: 'disabled' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('notifier with no target returns no-target without any network call', async () => {
  const fetchImpl = stubFetch(jsonResponse({ ok: true }));
  const notifier = createNotifier({ fetchImpl, enabled: true });
  const res = await notifier.notify('', { a: 1 });
  assert.deepEqual(res, { delivered: false, reason: 'no-target' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('notifier blocks SSRF target without a network call and logs redacted', async () => {
  const fetchImpl = stubFetch(jsonResponse({ ok: true }));
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const notifier = createNotifier({ fetchImpl, enabled: true, logger });
  const res = await notifier.notify('http://169.254.169.254/latest/', { a: 1 });
  assert.deepEqual(res, { delivered: false, reason: 'blocked' });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('169.254'));
});

test('notifier POSTs JSON to an allowed target on success', async () => {
  const fetchImpl = stubFetch(jsonResponse({ received: true }));
  const notifier = createNotifier({ fetchImpl, enabled: true, timeoutMs: 1234 });
  const payload = { symbol: 'BTC', price: 42 };
  const res = await notifier.notify('https://example.com/hook', payload);
  assert.deepEqual(res, { delivered: true, status: 200 });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, options } = fetchImpl.calls[0];
  assert.equal(url, 'https://example.com/hook');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(options.body, JSON.stringify(payload));
});

test('notifier catches a rejecting fetch and returns an error without throwing', async () => {
  const fetchImpl = rejectingFetch(new Error('network down'));
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const notifier = createNotifier({ fetchImpl, enabled: true, logger });
  const res = await notifier.notify('https://example.com/hook', { a: 1 });
  assert.equal(res.delivered, false);
  assert.equal(res.reason, 'error');
  assert.ok(typeof res.error === 'string');
  assert.equal(warnings.length, 1);
});

test('notifier works without a logger on block and error paths', async () => {
  const blockNotifier = createNotifier({ enabled: true });
  assert.deepEqual(await blockNotifier.notify('http://localhost/x', {}), {
    delivered: false,
    reason: 'blocked'
  });
  const errNotifier = createNotifier({ fetchImpl: rejectingFetch(), enabled: true });
  const res = await errNotifier.notify('https://example.com/x', {});
  assert.equal(res.reason, 'error');
});
