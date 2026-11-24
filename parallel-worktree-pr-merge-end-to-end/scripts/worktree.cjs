'use strict';
// One isolated worktree + branch per task, outside the main checkout.
//   node worktree.cjs new <task-slug>      -> prints the new folder
//   node worktree.cjs list
//   node worktree.cjs remove <slug> [--delete-branch]
const fs = require('fs');
const path = require('path');
const { git, gitOut, parseFlags } = require('./common.cjs');
const { loadConfig, mainRoot, resolveWorktreeDir } = require('./config.cjs');

// PURE
function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '');
}

// PURE. Output of `git worktree list --porcelain` -> [{path, head, branch}]
function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: null, branch: null };
      out.push(cur);
    } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
}

// Removes a symlink / junction WITHOUT following it. Never touches the target.
// Returns 'removed' | 'absent' | 'not-a-link'.
function removeLink(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return 'absent';
    throw e;
  }
  if (!st.isSymbolicLink()) return 'not-a-link';
  try {
    fs.unlinkSync(p);
  } catch (_) {
    fs.rmdirSync(p); // Windows junction: removes the reparse point only
  }
  return 'removed';
}

// Finds links anywhere in a tree without entering them, and removes them.
function removeAllLinks(dir) {
  let n = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      if (removeLink(p) === 'removed') n++;
    } else if (e.isDirectory() && e.name !== '.git') n += removeAllLinks(p);
  }
  return n;
}

function linkDependency(src, dest) {
  const st = fs.statSync(src);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const type = st.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
  fs.symlinkSync(src, dest, type);
}

function createWorktree(cwd, rawSlug) {
  const slug = slugify(rawSlug);
  if (!slug) throw Object.assign(new Error('task slug is empty after cleaning'), { exitCode: 2 });
  const root = mainRoot(cwd);
  const cfg = loadConfig(root);
  const base = cfg.baseBranch;
  const dir = path.join(resolveWorktreeDir(root, cfg), slug);
  const branch = 'pr/' + slug;
  if (fs.existsSync(dir)) throw Object.assign(new Error('folder already exists: ' + dir), { exitCode: 2 });
  if (git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).status === 0) {
    throw Object.assign(new Error('branch already exists: ' + branch), { exitCode: 2 });
  }
  const f = git(root, ['fetch', 'origin', base]);
  if (f.status !== 0) throw Object.assign(new Error('could not fetch origin/' + base + ': ' + f.stderr.trim()), { exitCode: 2 });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const add = git(root, ['worktree', 'add', '--no-track', '-b', branch, dir, 'origin/' + base]);
  if (add.status !== 0) throw Object.assign(new Error('git worktree add failed: ' + add.stderr.trim()), { exitCode: 2 });
  const notes = [];
  for (const dep of cfg.linkDependencies) {
    const src = path.join(root, dep);
    const dest = path.join(dir, dep);
    if (!fs.existsSync(src)) { notes.push('skipped ' + dep + ' (not in the main checkout)'); continue; }
    if (fs.existsSync(dest)) { notes.push('skipped ' + dep + ' (already in the worktree)'); continue; }
    try { linkDependency(src, dest); } catch (e) { notes.push('could not link ' + dep + ': ' + e.message); }
  }
  return { dir, branch, notes };
}

function removeWorktree(cwd, rawSlug, deleteBranch) {
  const slug = slugify(rawSlug);
  const root = mainRoot(cwd);
  const cfg = loadConfig(root);
  const dir = path.join(resolveWorktreeDir(root, cfg), slug);
  const branch = 'pr/' + slug;
  if (!slug) throw Object.assign(new Error('slug is empty'), { exitCode: 2 });
  const links = [];
  if (fs.existsSync(dir)) {
    // 1. unlink dependencies first, so nothing below can reach the main checkout
    for (const dep of cfg.linkDependencies) links.push(removeLink(path.join(dir, dep)));
    removeAllLinks(dir);
    const r = git(root, ['worktree', 'remove', '--force', dir]);
    if (r.status !== 0 && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  git(root, ['worktree', 'prune']);
  if (deleteBranch) git(root, ['branch', '-D', branch]);
  return { dir, branch };
}

function main(argv) {
  const cmd = argv[0];
  try {
    const { flags, rest } = parseFlags(argv.slice(1), { 'delete-branch': 'bool' });
    if (cmd === 'new' && rest[0]) {
      const r = createWorktree(process.cwd(), rest.join(' '));
      for (const n of r.notes) console.error('[worktree] ' + n);
      console.error('[worktree] branch ' + r.branch);
      console.log(r.dir);
      return 0;
    }
    if (cmd === 'list') {
      const root = mainRoot(process.cwd());
      const items = parseWorktreeList(gitOut(root, ['worktree', 'list', '--porcelain']));
      for (const w of items) console.log((w.branch || '(detached)') + '\t' + w.path);
      return 0;
    }
    if (cmd === 'remove' && rest[0]) {
      const r = removeWorktree(process.cwd(), rest[0], !!flags['delete-branch']);
      console.error('[worktree] removed ' + r.dir);
      return 0;
    }
  } catch (e) {
    console.error('[worktree] ' + e.message);
    return e.exitCode || 2;
  }
  console.error('usage: worktree.cjs new <task-slug> | list | remove <slug> [--delete-branch]');
  return 2;
}

module.exports = { slugify, parseWorktreeList, removeLink, removeAllLinks, createWorktree, removeWorktree };

if (require.main === module) process.exit(main(process.argv.slice(2)));
