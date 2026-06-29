const levels = ['debug', 'info', 'warn', 'error'];

export function createLogger({ level = 'info', sink = console } = {}) {
  const minimum = levels.includes(level) ? levels.indexOf(level) : levels.indexOf('info');

  function write(levelName, message, context = {}) {
    if (levels.indexOf(levelName) < minimum) return;
    const record = {
      timestamp: new Date().toISOString(),
      level: levelName,
      message,
      ...redact(context)
    };
    const method = levelName === 'error' ? 'error' : levelName === 'warn' ? 'warn' : 'log';
    sink[method](JSON.stringify(record));
  }

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context)
  };
}

function redact(value) {
  return JSON.parse(JSON.stringify(value, (key, current) => {
    if (/key|token|secret|password|authorization|signature|bearer|credential/i.test(key)) return '[REDACTED]';
    return current;
  }));
}
