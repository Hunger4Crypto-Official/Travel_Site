import { readFileSync } from 'node:fs';

// Minimal, dependency-free .env support so "put keys in .env and npm start"
// actually works. Existing process.env values always win, so real environment
// configuration (containers, CI, secret managers) is never overridden.

// Parses .env file content into a plain object. Supports KEY=VALUE lines,
// blank lines, full-line # comments, `export ` prefixes, and single- or
// double-quoted values.
export function parseDotEnv(content) {
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

// Loads `path` (default ./.env) into `env` without overriding existing keys.
// A missing file is not an error — it simply means nothing to load.
export function loadDotEnv({ path = '.env', env = process.env } = {}) {
  let content;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const parsed = parseDotEnv(content);
  const applied = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied[key] = value;
    }
  }
  return applied;
}
