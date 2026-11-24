'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./_helpers.cjs');
const q = require('../test-queue.cjs');

const DEAD_PID = 2147483646;

function slotsDir() {
  return path.join(process.env.PARALLEL_PR_HOME, 'slots');
}

function fillSlots(n, pid, startedAt) {
  fs.mkdirSync(slotsDir(), { recursive: true });
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(slotsDir(), 'slot-' + i + '.lock'), JSON.stringify({ pid, startedAt }));
}

function setup() {
  const w = h.makeWorld();
  delete process.env.PARALLEL_PR_FREEMEM_GB;
  return w;
}

test('memoryOk and buildSpawn', () => {
  assert.strictEqual(q.memoryOk(3 * 1024 ** 3, 2), true);
  assert.strictEqual(q.memoryOk(1 * 1024 ** 3, 2), false);
  assert.deepStrictEqual(q.buildSpawn(['npm test'], 'linux'), { cmd: 'npm test', args: [], shell: true });
  assert.deepStrictEqual(q.buildSpawn(['node', 'a.js'], 'linux'), { cmd: 'node', args: ['a.js'], shell: false });
  assert.strictEqual(q.buildSpawn(['npm', 'test'], 'win32').cmd, 'npm.cmd');
});

test('runs the command and returns its exit code; logs the run', () => {
  const w = setup();
  const ok = h.node('test-queue.cjs', ['--', process.execPath, '-e', 'process.exit(0)'], w.repo);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const red = h.node('test-queue.cjs', ['--', process.execPath, '-e', 'process.exit(3)'], w.repo);
  assert.strictEqual(red.status, 3);
  const log = fs.readFileSync(path.join(w.home, 'queue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(log.map((e) => e.exit), [0, 3]);
  assert.deepStrictEqual(fs.readdirSync(slotsDir()), [], 'slot freed after each run');
});

test('usage error without a command', () => {
  const w = setup();
  assert.strictEqual(h.node('test-queue.cjs', [], w.repo).status, 2);
});

test('all slots busy with live owners: waits, then gives up (124)', () => {
  const w = setup();
  fillSlots(2, process.pid, Date.now());
  const r = h.node('test-queue.cjs', ['--timeout', '1', '--', process.execPath, '-e', 'process.exit(0)'], w.repo);
  assert.strictEqual(r.status, 124);
});

test('slots held by dead processes are taken over', () => {
  const w = setup();
  fillSlots(2, DEAD_PID, Date.now());
  const r = h.node('test-queue.cjs', ['--timeout', '5', '--', process.execPath, '-e', 'process.exit(0)'], w.repo);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('a stuck suite (alive but older than the limit) loses its slot', () => {
  const w = setup();
  fillSlots(2, process.pid, Date.now() - 60 * 60 * 1000);
  const r = h.node('test-queue.cjs', ['--timeout', '5', '--', process.execPath, '-e', 'process.exit(0)'], w.repo);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('not enough free memory: does not start (124)', () => {
  const w = setup();
  process.env.PARALLEL_PR_FREEMEM_GB = '0.1';
  try {
    const r = h.node('test-queue.cjs', ['--timeout', '1', '--', process.execPath, '-e', 'process.exit(0)'], w.repo);
    assert.strictEqual(r.status, 124);
  } finally {
    delete process.env.PARALLEL_PR_FREEMEM_GB;
  }
});
