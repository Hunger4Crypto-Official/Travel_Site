export class MetricsRegistry {
  constructor() {
    this.counters = new Map();
    this.timings = new Map();
  }

  increment(name, labels = {}, amount = 1) {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + amount);
  }

  observe(name, milliseconds, labels = {}) {
    const key = metricKey(name, labels);
    const current = this.timings.get(key) || { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += milliseconds;
    current.maxMs = Math.max(current.maxMs, milliseconds);
    this.timings.set(key, current);
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters.entries()),
      timings: Object.fromEntries([...this.timings.entries()].map(([key, value]) => [key, {
        ...value,
        averageMs: value.count === 0 ? 0 : Number((value.totalMs / value.count).toFixed(2))
      }]))
    };
  }
}

function metricKey(name, labels) {
  const suffix = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return suffix ? `${name}{${suffix}}` : name;
}
