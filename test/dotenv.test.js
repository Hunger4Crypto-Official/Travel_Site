import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseDotEnv, loadDotEnv } from '../src/config/dotenv.js';

const fixturePath = fileURLToPath(new URL('./fixtures/sample.env', import.meta.url));

test('parseDotEnv handles comments, export prefix, quotes, and junk lines', () => {
  const parsed = parseDotEnv([
    '# comment',
    'A=1',
    'export B=two',
    'C="quoted value"',
    "D='single'",
    'E=',
    'F = spaced ',
    'garbage line',
    '9BAD=skip'
  ].join('\n'));

  assert.deepEqual(parsed, { A: '1', B: 'two', C: 'quoted value', D: 'single', E: '', F: 'spaced' });
});

test('loadDotEnv applies file values without overriding existing environment', () => {
  const env = { AMADEUS_CLIENT_ID: 'from-real-env' };
  const applied = loadDotEnv({ path: fixturePath, env });

  // Existing env always wins.
  assert.equal(env.AMADEUS_CLIENT_ID, 'from-real-env');
  assert.equal(applied.AMADEUS_CLIENT_ID, undefined);

  // New keys are applied.
  assert.equal(env.TRAVELPAYOUTS_TOKEN, 'tok-x');
  assert.equal(env.QUOTED, 'hello world');
  assert.equal(env.SINGLE, 'single quoted');
  assert.equal(env.SPACED, 'padded value');
  assert.equal(env['1BADKEY'], undefined);
});

test('loadDotEnv treats a missing file as nothing to load', () => {
  const env = {};
  assert.deepEqual(loadDotEnv({ path: '/nonexistent/definitely-not-here.env', env }), {});
  assert.deepEqual(env, {});
});
