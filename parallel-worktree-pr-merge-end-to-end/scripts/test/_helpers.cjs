'use strict';
// Test helpers: temp repositories with a local bare "origin", a fake `gh`, a fake review engine.
// Nothing here touches the network or any real repository.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// Never let an inherited git location leak into a test (it would write into a real repo).
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete process.env[k];
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0', PARALLEL_PR_POLL_MS: '50',
});

const SCRIPTS = path.resolve(__dirname, '..');

const FAKE_GH = `'use strict';
const fs = require('fs'); const cp = require('child_process');
const env = Object.assign({}, process.env); for (const k of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE']) delete env[k];
const a = process.argv.slice(2);
const sf = process.env.FAKE_GH_STATE; const origin = process.env.FAKE_ORIGIN;
const st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : { prs: [], calls: [] };
const save = () => fs.writeFileSync(sf, JSON.stringify(st));
const opt = (n) => { const i = a.indexOf(n); return i < 0 ? null : a[i + 1]; };
const git = (...x) => cp.execFileSync('git', ['--git-dir', origin, ...x], { env, encoding: 'utf8' }).trim();
st.calls.push(a.slice(0, 2).join(' '));
if (a[0] === '--version') { console.log('gh fake'); process.exit(0); }
if (a[0] === 'auth') process.exit(0);
if (a[0] === 'pr' && a[1] === 'list') {
  const state = opt('--state'); const head = opt('--head');
  console.log(JSON.stringify(st.prs.filter((p) => p.head === head && p.state === state).map((p) => ({ number: p.number, url: 'https://example.invalid/pr/' + p.number }))));
} else if (a[0] === 'pr' && a[1] === 'create') {
  st.prs.push({ number: st.prs.length + 1, head: opt('--head'), title: opt('--title'), body: fs.readFileSync(opt('--body-file'), 'utf8'), state: 'open' });
  save(); console.log('https://example.invalid/pr/' + st.prs.length);
} else if (a[0] === 'pr' && a[1] === 'edit') { save(); }
else if (a[0] === 'pr' && a[1] === 'view') {
  const p = st.prs.find((x) => x.number === Number(a[2]));
  console.log(JSON.stringify({ headRefOid: git('rev-parse', 'refs/heads/' + p.head), headRefName: p.head, title: p.title, body: p.body }));
} else if (a[0] === 'pr' && a[1] === 'merge') {
  const p = st.prs.find((x) => x.number === Number(a[2])); const want = opt('--match-head-commit');
  const have = git('rev-parse', 'refs/heads/' + p.head);
  st.calls.push('MATCH ' + want + ' HAVE ' + have);
  if (!want || want !== have) { save(); console.error('head commit does not match'); process.exit(1); }
  try { git('merge-base', '--is-ancestor', 'refs/heads/main', have); } catch (_) { save(); console.error('not fast-forward'); process.exit(1); }
  git('update-ref', 'refs/heads/main', have); p.state = 'merged'; save();
} else { console.error('fake gh: unsupported ' + a.join(' ')); process.exit(1); }
save();
`;

const FAKE_ENGINE = `'use strict';
const cp = require('child_process'); const fs = require('fs');
if (process.argv[2] === '--version') { console.log('fake 1'); process.exit(0); }
const v = process.env.FAKE_ENGINE_VERDICT || 'APPROVE';
fs.readFileSync(0);
if (process.env.FAKE_ENGINE_FIX) {
  fs.writeFileSync('reviewer-fix.txt', 'fixed\\n');
  cp.execFileSync('git', ['add', 'reviewer-fix.txt']); cp.execFileSync('git', ['commit', '-m', 'fix by reviewer', '--', 'reviewer-fix.txt']);
}
if (v === 'NONE') { console.log('I have thoughts but no verdict'); process.exit(0); }
console.log('Looked at the diff.\\nVERDICT: ' + v);
`;

function git(cwd, args) {
  const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ppr-'));
}

// config: overrides for .parallel-pr.json
function makeWorld(overrides) {
  const tmp = tmpDir('ppr-world-');
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'widgets');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  cp.execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  cp.execFileSync('git', ['clone', origin, repo], { stdio: 'ignore' });
  const cfg = Object.assign({
    version: 1, repo: 'acme/widgets', baseBranch: 'main', testCommand: 'node check.cjs',
    linkDependencies: ['node_modules'], review: { requiredFor: 'critical', criticalPaths: ['secure/**'], engines: ['claude'], maxParallel: 2 },
  }, overrides || {});
  fs.writeFileSync(path.join(repo, '.parallel-pr.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(repo, 'check.cjs'), "const fs=require('fs');process.exit(fs.existsSync('FAIL')?1:0);\n");
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(repo, ['add', '.parallel-pr.json', 'check.cjs', 'a.txt', '.gitignore']);
  git(repo, ['commit', '-m', 'seed']);
  git(repo, ['push', '-u', 'origin', 'main']);
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.writeFileSync(path.join(repo, 'node_modules', 'dep.txt'), 'dependency\n');

  const ghStub = path.join(tmp, 'fake-gh.cjs');
  fs.writeFileSync(ghStub, FAKE_GH);
  const engine = path.join(tmp, 'fake-engine.cjs');
  fs.writeFileSync(engine, FAKE_ENGINE);
  const missing = path.join(tmp, 'does-not-exist.cjs');
  const state = path.join(tmp, 'gh-state.json');
  Object.assign(process.env, {
    PARALLEL_PR_HOME: home, PARALLEL_PR_GH: ghStub, FAKE_GH_STATE: state, FAKE_ORIGIN: origin,
    PARALLEL_PR_BIN_CLAUDE: engine, PARALLEL_PR_BIN_CODEX: missing, PARALLEL_PR_BIN_GEMINI: missing,
    FAKE_ENGINE_VERDICT: 'APPROVE',
  });
  delete process.env.FAKE_ENGINE_FIX;
  return { tmp, origin, repo, home, state, engine, missing, wtRoot: path.join(tmp, 'widgets-wt') };
}

function node(script, args, cwd) {
  const r = cp.spawnSync(process.execPath, [path.join(SCRIPTS, script)].concat(args), { cwd, encoding: 'utf8', env: process.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function newTask(w, slug, files) {
  const r = node('worktree.cjs', ['new', slug], w.repo);
  if (r.status !== 0) throw new Error('worktree new failed: ' + r.stderr);
  const dir = r.stdout.trim();
  const names = [];
  for (const [name, content] of Object.entries(files || { 'feature.txt': 'hello\n' })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
    names.push(name);
  }
  git(dir, ['add', '--'].concat(names));
  git(dir, ['commit', '-m', 'work on ' + slug, '--'].concat(names));
  return dir;
}

function deliver(w, dir, extra) {
  const body = path.join(w.tmp, 'body.md');
  fs.writeFileSync(body, 'What and why.\n');
  return node('deliver.cjs', ['--dir', dir, '--body', body, '--max-wait', '1'].concat(extra || []), w.repo);
}

function originFiles(w, ref) {
  return git(w.origin, ['ls-tree', '-r', '--name-only', ref || 'main']).split(/\r?\n/);
}

function ghState(w) {
  return fs.existsSync(w.state) ? JSON.parse(fs.readFileSync(w.state, 'utf8')) : { prs: [], calls: [] };
}

module.exports = { SCRIPTS, git, tmpDir, makeWorld, node, newTask, deliver, originFiles, ghState };
