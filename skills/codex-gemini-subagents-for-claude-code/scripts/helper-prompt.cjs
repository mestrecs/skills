'use strict';
const fs = require('fs');
const path = require('path');

function buildHelperPrompt(request, dir) {
  const checklist = fs.readFileSync(path.join(__dirname, '..', 'references', 'failure-cases.md'), 'utf8');
  return request
    + '\n\nRules: Only edit project files inside ' + dir + '. Keep temporary files outside the worktree. '
    + 'Never run git push directly, never use --no-verify, never merge pull requests manually, '
    + 'never run broad test suites unless explicitly requested, and never print, log or commit secrets or environment variables.\n\n'
    + 'Follow this checklist when the task writes or changes code.\n\n' + checklist;
}

module.exports = { buildHelperPrompt };
