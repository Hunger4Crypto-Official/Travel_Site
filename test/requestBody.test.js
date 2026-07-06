import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../src/utils/requestBody.js';

// A minimal request stand-in whose data/end/error we drive by hand, so every
// branch is deterministic.
function fakeReq() {
  const emitter = new EventEmitter();
  emitter.destroyed = false;
  emitter.destroy = () => { emitter.destroyed = true; };
  return emitter;
}

test('readJsonBody parses a JSON body delivered in chunks', async () => {
  const req = fakeReq();
  const promise = readJsonBody(req);
  req.emit('data', Buffer.from('{"type":"fli'));
  req.emit('data', Buffer.from('ghts","threshold":250}'));
  req.emit('end');
  assert.deepEqual(await promise, { type: 'flights', threshold: 250 });
});

test('readJsonBody resolves an empty body to {}', async () => {
  const req = fakeReq();
  const promise = readJsonBody(req);
  req.emit('end');
  assert.deepEqual(await promise, {});
});

test('readJsonBody rejects malformed JSON with a 400', async () => {
  const req = fakeReq();
  const promise = readJsonBody(req);
  req.emit('data', Buffer.from('{not json'));
  req.emit('end');
  await assert.rejects(promise, (err) => err.statusCode === 400 && /valid JSON/.test(err.message));
});

test('readJsonBody rejects and destroys the request when the body exceeds the cap', async () => {
  const req = fakeReq();
  const promise = readJsonBody(req, { maxBytes: 8 });
  req.emit('data', Buffer.from('0123456789')); // 10 bytes > 8
  await assert.rejects(promise, (err) => err.statusCode === 400 && /too large/.test(err.message));
  assert.equal(req.destroyed, true);
  // A late end after destroy must not settle the promise again (no throw).
  req.emit('end');
});

test('readJsonBody rejects on a stream error', async () => {
  const req = fakeReq();
  const promise = readJsonBody(req);
  req.emit('error', new Error('socket reset'));
  await assert.rejects(promise, (err) => err.statusCode === 400 && /read request body/.test(err.message));
});
