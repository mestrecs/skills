'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./_helpers.cjs');
const c = require('../common.cjs');

const DEAD_PID = 2147483646;

test('isStaleLock: dead owner, stuck owner, fresh live owner, half-written file', () => {
  const now = 1_000_000;
  assert.strictEqual(c.isStaleLock({ pid: 1, startedAt: now }, { now, stuckMs: 0, alive: false, fileAgeMs: 0 }), true, 'dead pid is stale');
  assert.strictEqual(c.isStaleLock({ pid: 1, startedAt: now - 20 * 60000 }, { now, stuckMs: 15 * 60000, alive: true, fileAgeMs: 0 }), true, 'alive but stuck is stale');
  assert.strictEqual(c.isStaleLock({ pid: 1, startedAt: now - 1000 }, { now, stuckMs: 15 * 60000, alive: true, fileAgeMs: 0 }), false, 'fresh and alive is kept');
  assert.strictEqual(c.isStaleLock(null, { now, stuckMs: 0, alive: false, fileAgeMs: 100 }), false, 'file still being written');
  assert.strictEqual(c.isStaleLock(null, { now, stuckMs: 0, alive: false, fileAgeMs: 60000 }), true, 'old garbage file');
});

test('tryCreateLock: live owner blocks, dead owner is taken over, only the owner releases', () => {
  const dir = h.tmpDir('ppr-lock-');
  const file = path.join(dir, 'x.lock');
  assert.strictEqual(c.tryCreateLock(file, {}, 0), true);
  assert.strictEqual(c.tryCreateLock(file, {}, 0), false, 'we are alive, lock is busy');
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }));
  assert.strictEqual(c.tryCreateLock(file, {}, 0), true, 'dead pid: taken over');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 3600_000 }));
  assert.strictEqual(c.tryCreateLock(file, {}, 60_000), true, 'alive but older than stuckMs: taken over');
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD_PID, startedAt: Date.now() }));
  c.releaseLock(file);
  assert.ok(fs.existsSync(file), 'a lock owned by someone else is not released by us');
});

test('tryAcquireSlot: respects the number of slots', () => {
  const dir = h.tmpDir('ppr-slots-');
  const a = c.tryAcquireSlot(dir, 2, {}, 0);
  const b = c.tryAcquireSlot(dir, 2, {}, 0);
  assert.ok(a && b && a !== b);
  assert.strictEqual(c.tryAcquireSlot(dir, 2, {}, 0), null);
});

test('cleanEnv drops inherited git location variables', () => {
  process.env.GIT_DIR = '/nowhere';
  try {
    assert.strictEqual(c.cleanEnv().GIT_DIR, undefined);
    assert.strictEqual(c.cleanEnv({ A: '1' }).A, '1');
  } finally {
    delete process.env.GIT_DIR;
  }
});

test('assertSafeArg rejects shell metacharacters', () => {
  assert.strictEqual(c.assertSafeArg('gpt-5.1', 'm'), 'gpt-5.1');
  assert.throws(() => c.assertSafeArg('x; rm -rf /', 'm'));
});

test('parseFlags: values, booleans, leftovers', () => {
  const r = c.parseFlags(['--a', '1', '--b', 'x', 'y'], { a: 'string', b: 'bool' });
  assert.deepStrictEqual(r.flags, { a: '1', b: true });
  assert.deepStrictEqual(r.rest, ['x', 'y']);
  assert.throws(() => c.parseFlags(['--a'], { a: 'string' }));
});
