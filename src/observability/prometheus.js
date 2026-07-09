// Render a MetricsRegistry snapshot (see src/observability/metrics.js) into the
// Prometheus text exposition format. The snapshot shape is:
//   { counters: { "<key>": number, ... }, timings: { "<key>": { count, totalMs, maxMs, averageMs }, ... } }
// where a key may embed labels, e.g. "http_request{route=/x}". Output is
// deterministic (keys sorted) and tolerant of missing or empty sections.

const PREFIX = 'ttc_';

// Prometheus metric names must match [a-zA-Z0-9_:]. Anything else, including the
// embedded label syntax, is collapsed to '_'. The ttc_ prefix namespaces the app.
export function sanitizeName(name) {
  return PREFIX + String(name).replace(/[^a-zA-Z0-9_:]/g, '_');
}

export function toPrometheus(snapshot) {
  const safe = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const counters = safe.counters && typeof safe.counters === 'object' ? safe.counters : {};
  const timings = safe.timings && typeof safe.timings === 'object' ? safe.timings : {};
  const lines = [];

  for (const key of Object.keys(counters).sort()) {
    const value = counters[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const metric = sanitizeName(key);
    lines.push(`# TYPE ${metric} counter`);
    lines.push(`${metric} ${value}`);
  }

  for (const key of Object.keys(timings).sort()) {
    const timing = timings[key];
    if (!timing || typeof timing !== 'object') continue;
    for (const field of Object.keys(timing).sort()) {
      const value = timing[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const metric = sanitizeName(`${key}_${field}`);
      lines.push(`# TYPE ${metric} gauge`);
      lines.push(`${metric} ${value}`);
    }
  }

  return lines.length ? `${lines.join('\n')}\n` : '';
}
