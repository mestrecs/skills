'use strict';
// Read-only look at the repository and the machine. Prints one JSON object.
//   node detect.cjs [--dir <path>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const common = require('./common.cjs');
const { repoRoot } = require('./config.cjs');

// PURE. "git@github.com:owner/name.git" or "https://github.com/owner/name" -> "owner/name"
function parseRepoFromUrl(url) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return m ? m[1] + '/' + m[2] : null;
}

// PURE. files = names present at the repo root; pkg = parsed package.json or null
function detectTestCommand(files, pkg) {
  if (pkg && pkg.scripts && pkg.scripts.test && !/no test specified/.test(pkg.scripts.test)) return 'npm test';
  if (files.includes('Cargo.toml')) return 'cargo test';
  if (files.includes('go.mod')) return 'go test ./...';
  if (files.includes('pytest.ini') || files.includes('pyproject.toml') || files.includes('tox.ini')) return 'pytest';
  if (files.includes('Gemfile')) return 'bundle exec rake test';
  if (files.includes('Makefile')) return 'make test';
  return null;
}

// PURE
function detectDeployHints(files, workflowNames) {
  const hints = [];
  const map = {
    'vercel.json': 'vercel', 'netlify.toml': 'netlify', 'fly.toml': 'fly.io', 'railway.json': 'railway',
    'railway.toml': 'railway', 'render.yaml': 'render', Procfile: 'procfile (heroku-style)',
    Dockerfile: 'docker', 'docker-compose.yml': 'docker-compose', 'docker-compose.yaml': 'docker-compose',
    'serverless.yml': 'serverless', 'app.yaml': 'google app engine',
  };
  for (const f of files) if (map[f]) hints.push(map[f]);
  for (const w of workflowNames) if (/deploy|release|publish/i.test(w)) hints.push('github actions workflow: ' + w);
  return Array.from(new Set(hints));
}

function installed(bin) {
  const r = common.engineRun(bin, ['--version'], { timeout: 15000 });
  return r.status === 0;
}

// Only checks that a login folder exists. Never opens or prints credential files.
function loginFolderExists(name) {
  return fs.existsSync(path.join(os.homedir(), name));
}

function detect(cwd) {
  const out = { repo: null, baseBranch: null, testCommand: null, os: process.platform, gh: { installed: false, authed: false }, engines: {}, deployHints: [] };
  let root = null;
  try { root = repoRoot(cwd); } catch (_) { /* not a repo */ }
  if (root) {
    const url = common.git(root, ['remote', 'get-url', 'origin']);
    if (url.status === 0) out.repo = parseRepoFromUrl(url.stdout);
    const head = common.git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (head.status === 0) out.baseBranch = head.stdout.trim().replace(/^origin\//, '');
    else {
      for (const b of ['main', 'master', 'develop']) {
        if (common.git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + b]).status === 0) { out.baseBranch = b; break; }
      }
    }
    const files = fs.readdirSync(root);
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch (_) { /* none */ }
    out.testCommand = detectTestCommand(files, pkg);
    let wf = [];
    try { wf = fs.readdirSync(path.join(root, '.github', 'workflows')); } catch (_) { /* none */ }
    out.deployHints = detectDeployHints(files, wf);
  }
  const ghv = common.gh(['--version'], { timeout: 15000 });
  out.gh.installed = ghv.status === 0;
  if (out.gh.installed) out.gh.authed = common.gh(['auth', 'status'], { timeout: 20000 }).status === 0;
  const logins = { claude: '.claude', codex: '.codex', gemini: '.gemini' };
  for (const name of ['claude', 'codex', 'gemini']) {
    const inst = installed(name);
    out.engines[name] = { installed: inst, authed: inst && loginFolderExists(logins[name]) };
  }
  return out;
}

function main(argv) {
  const { flags } = common.parseFlags(argv, { dir: 'string' });
  console.log(JSON.stringify(detect(path.resolve(flags.dir || process.cwd())), null, 2));
  return 0;
}

module.exports = { parseRepoFromUrl, detectTestCommand, detectDeployHints, detect };

if (require.main === module) process.exit(main(process.argv.slice(2)));
