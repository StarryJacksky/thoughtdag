// The research fixtures as the host side reads them: plain JSON, no bundler.
// Guards the one rule that matters before any test touches a runtime: the
// fixtures are synthetic and name no real machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'fixtures', 'research');
const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

test('the baseline fixtures are present', () => {
  for (const name of ['single-parent-edited-ancestor', 'excluded-attachment', 'same-name-different-dirs']) {
    assert.ok(names.includes(name + '.json'), name + ' is missing');
  }
});

for (const file of names) {
  test(file + ' parses and carries the fields every scenario needs', () => {
    const f = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    assert.equal(typeof f.description, 'string');
    assert.ok(Array.isArray(f.graph.nodes) && f.graph.nodes.length > 0);
    assert.ok(Array.isArray(f.graph.edges));
    assert.ok(['research', 'workspace'].includes(f.policy.mode));
    assert.ok(f.graph.nodes.some((n) => n.id === f.expected.targetNodeId));
  });

  test(file + ' is synthetic: no home directory, no real user path', () => {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    assert.ok(!text.includes(os.homedir()), 'contains this machine\'s home directory');
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|[A-Za-z]:\\\\Users\\\\/);
    const f = JSON.parse(text);
    for (const p of [f.policy.cwd, f.nativeHistory && f.nativeHistory.cwd, f.nativeHistory && f.nativeHistory.sessionFile].filter(Boolean)) {
      assert.ok(p.startsWith('/synthetic/'), p + ' is not under /synthetic/');
    }
  });
}
