'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const h = require('./_helpers.cjs');
const cfgMod = require('../config.cjs');

const valid = () => cfgMod.mergeDeep(cfgMod.DEFAULTS, { repo: 'acme/widgets' });

test('defaults plus a repo are valid', () => {
  assert.deepStrictEqual(cfgMod.validateConfig(valid()), []);
});

test('mergeDeep keeps nested defaults and replaces arrays', () => {
  const m = cfgMod.mergeDeep(cfgMod.DEFAULTS, { repo: 'a/b', parallel: { suiteSlots: 4 }, linkDependencies: [] });
  assert.strictEqual(m.parallel.suiteSlots, 4);
  assert.strictEqual(m.parallel.stuckSuiteMinutes, 15);
  assert.deepStrictEqual(m.linkDependencies, []);
});

test('validateConfig catches the mistakes that matter', () => {
  const bad = (patch) => cfgMod.validateConfig(cfgMod.mergeDeep(valid(), patch));
  assert.ok(bad({ repo: 'nope' }).length);
  assert.ok(bad({ baseBranch: '--force' }).length);
  assert.ok(bad({ review: { requiredFor: 'sometimes' } }).length);
  assert.ok(bad({ review: { engines: ['skynet'] } }).length);
  assert.ok(bad({ review: { codex: { model: 'x; rm -rf /' } } }).length);
  assert.ok(bad({ deploy: { mode: 'command', command: null } }).length);
  assert.ok(bad({ deploy: { mode: 'vps-ssh' } }).length);
  assert.ok(bad({ deploy: { mode: 'vps-ssh', ssh: { host: 'a b', user: 'u', path: '/p', update: 'x' } } }).length);
  assert.ok(bad({ deploy: { restartWindow: '3am' } }).length);
  assert.ok(bad({ timezone: 'Mars/Base' }).length);
  assert.ok(bad({ linkDependencies: ['../secret'] }).length);
  assert.ok(bad({ parallel: { suiteSlots: 0 } }).length);
});

test('loadConfig and resolveWorktreeDir against a real temp repository', () => {
  const w = h.makeWorld();
  const cfg = cfgMod.loadConfig(cfgMod.repoRoot(w.repo));
  assert.strictEqual(cfg.repo, 'acme/widgets');
  assert.strictEqual(cfg.parallel.suiteSlots, 2);
  assert.strictEqual(path.basename(cfgMod.resolveWorktreeDir(w.repo, cfg)), 'widgets-wt');
  assert.throws(() => cfgMod.loadConfig(w.tmp), (e) => e.code === 'NOCONFIG');
});

test('mainRoot from inside a linked worktree points at the main checkout', () => {
  const w = h.makeWorld();
  const dir = h.newTask(w, 'root-check');
  assert.strictEqual(path.resolve(cfgMod.mainRoot(dir)).toLowerCase(), path.resolve(w.repo).toLowerCase());
});
