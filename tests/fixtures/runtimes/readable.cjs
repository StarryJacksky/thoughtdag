// What a fake agent could read of the canvas's materials: every file under
// <cwd>/.thoughtdag/materials, by relative path, with its text. The fakes
// record this when a turn starts, so a test can assert on the files an
// agent was given and not only on its prompt.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readableMaterials(cwd) {
  const root = path.join(String(cwd || ''), '.thoughtdag', 'materials');
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push({ path: path.relative(root, full), content: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return files;
}

module.exports = { readableMaterials };
