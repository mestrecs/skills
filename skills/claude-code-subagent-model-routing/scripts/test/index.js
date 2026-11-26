'use strict';
// `node --test scripts/test/` on Node >= 21 does not expand a folder into its files,
// so this entry loads every *.test.cjs file. On Node 20 it is a no-op.
const fs = require('fs');
const path = require('path');

if (Number(process.versions.node.split('.')[0]) >= 21) {
  for (const f of fs.readdirSync(__dirname).sort()) {
    if (f.endsWith('.test.cjs')) require(path.join(__dirname, f));
  }
}
