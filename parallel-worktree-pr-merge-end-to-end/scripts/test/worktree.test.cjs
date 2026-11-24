'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./_helpers.cjs');
const wt = require('../worktree.cjs');

test('slugify', () => {
  assert.strictEqual(wt.slugify('Fix: Login  defect #12!'), 'fix-login-defect-12');
  assert.strictEqual(wt.slugify('../../etc'), 'etc');
  assert.strictEqual(wt.slugify('***'), '');
  assert.ok(wt.slugify('x'.repeat(200)).length <= 50);
});

test('parseWorktreeList', () => {
  const out = 'worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\nbranch refs/heads/pr/x\n\nworktree /c\nHEAD 123\ndetached\n';
  const l = wt.parseWorktreeList(out);
  assert.deepStrictEqual(l.map((x) => x.branch), ['main', 'pr/x', null]);
  assert.strictEqual(l[1].path, '/b');
});

test('new: worktree outside the repo, branch pr/<slug>, dependencies linked', () => {
  const w = h.makeWorld();
  const r = h.node('worktree.cjs', ['new', 'My First Task'], w.repo);
  assert.strictEqual(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.strictEqual(path.basename(dir), 'my-first-task');
  assert.ok(!dir.startsWith(w.repo + path.sep), 'worktree must be outside the main checkout');
  assert.strictEqual(h.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'pr/my-first-task');
  assert.ok(fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink(), 'node_modules is a link');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'node_modules', 'dep.txt'), 'utf8'), 'dependency\n');
  assert.notStrictEqual(h.node('worktree.cjs', ['new', 'My First Task'], w.repo).status, 0, 'same slug twice is refused');
  assert.notStrictEqual(h.node('worktree.cjs', ['new', '***'], w.repo).status, 0, 'empty slug is refused');
});

test('remove: unlinks the dependency WITHOUT following it, the main checkout keeps its files', () => {
  const w = h.makeWorld();
  const dir = h.newTask(w, 'to-remove');
  fs.mkdirSync(path.join(dir, 'pkg'));
  // a second, nested link made by some tool inside the worktree
  fs.symlinkSync(path.join(w.repo, 'node_modules'), path.join(dir, 'pkg', 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  const list = h.node('worktree.cjs', ['list'], w.repo);
  assert.match(list.stdout, /pr\/to-remove/);
  const r = h.node('worktree.cjs', ['remove', 'to-remove', '--delete-branch'], w.repo);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(dir), 'worktree folder is gone');
  assert.strictEqual(fs.readFileSync(path.join(w.repo, 'node_modules', 'dep.txt'), 'utf8'), 'dependency\n', 'target of the links is untouched');
  assert.notStrictEqual(h.git(w.repo, ['branch', '--list', 'pr/to-remove']).length > 0, true, 'branch deleted');
});

test('removeLink never deletes a real folder', () => {
  const d = h.tmpDir('ppr-link-');
  fs.mkdirSync(path.join(d, 'real'));
  fs.writeFileSync(path.join(d, 'real', 'f.txt'), 'x');
  assert.strictEqual(wt.removeLink(path.join(d, 'real')), 'not-a-link');
  assert.ok(fs.existsSync(path.join(d, 'real', 'f.txt')));
  assert.strictEqual(wt.removeLink(path.join(d, 'missing')), 'absent');
});
