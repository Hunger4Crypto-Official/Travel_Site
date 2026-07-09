import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPrometheus, sanitizeName } from '../../src/observability/prometheus.js';
import { MetricsRegistry } from '../../src/observability/metrics.js';

test('renders counters and timing gauges from a real snapshot', () => {
  const registry = new MetricsRegistry();
  registry.increment('http_request', { route: '/book' }, 2);
  registry.observe('handler_latency', 40, { route: '/book' });
  registry.observe('handler_latency', 60, { route: '/book' });
  const out = toPrometheus(registry.snapshot());

  // Counter TYPE line and sanitized, prefixed name (labels collapsed to '_').
  assert.match(out, /# TYPE ttc_http_request_route__book_ counter/);
  assert.match(out, /^ttc_http_request_route__book_ 2$/m);

  // Timing sub-fields become gauges, one per numeric field.
  assert.match(out, /# TYPE ttc_handler_latency_route__book__count gauge/);
  assert.match(out, /^ttc_handler_latency_route__book__count 2$/m);
  assert.match(out, /# TYPE ttc_handler_latency_route__book__averageMs gauge/);
  assert.match(out, /^ttc_handler_latency_route__book__averageMs 50$/m);
  assert.match(out, /^ttc_handler_latency_route__book__totalMs 100$/m);

  // Every metric name is prefixed and only uses [a-zA-Z0-9_:].
  for (const line of out.trim().split('\n')) {
    const name = line.startsWith('# TYPE ') ? line.split(' ')[2] : line.split(' ')[0];
    assert.ok(name.startsWith('ttc_'), `expected ttc_ prefix: ${name}`);
    assert.match(name, /^[a-zA-Z0-9_:]+$/);
  }

  // Deterministic: same snapshot renders identically.
  assert.equal(out, toPrometheus(registry.snapshot()));
});

test('tolerates missing and empty sections', () => {
  assert.equal(toPrometheus(undefined), '');
  assert.equal(toPrometheus(null), '');
  assert.equal(toPrometheus(42), '');
  assert.equal(toPrometheus({}), '');
  assert.equal(toPrometheus({ counters: {}, timings: {} }), '');
  // Truthy but non-object sections fall back to empty.
  assert.equal(toPrometheus({ counters: 5, timings: 'x' }), '');
});

test('skips non-numeric and non-finite values', () => {
  const out = toPrometheus({
    counters: { good: 3, bad: 'nope', infinite: Infinity },
    timings: {
      broken: null,
      notObject: 7,
      mixed: { count: 4, label: 'skip', nan: NaN }
    }
  });
  assert.match(out, /^ttc_good 3$/m);
  assert.doesNotMatch(out, /bad/);
  assert.doesNotMatch(out, /infinite/);
  assert.doesNotMatch(out, /broken/);
  assert.doesNotMatch(out, /notObject/);
  assert.match(out, /^ttc_mixed_count 4$/m);
  assert.doesNotMatch(out, /mixed_label/);
  assert.doesNotMatch(out, /mixed_nan/);
});

test('sanitizeName prefixes and replaces disallowed characters', () => {
  assert.equal(sanitizeName('a.b-c/d'), 'ttc_a_b_c_d');
  assert.equal(sanitizeName('ok:name_1'), 'ttc_ok:name_1');
});
