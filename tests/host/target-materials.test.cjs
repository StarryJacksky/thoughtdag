// What each run is given on disk (T27): under a directory of its own, from its own
// envelope. A real temp folder; nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { materializeRun } = require('../../runtime/agents/ops.cjs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-target-materials-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex');
const SUPPORTED = { runtime: 'codex', capabilities: { readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'supported' } };
function envelope(runId, inputId, text, mode = 'workspace') {
  return {
    runId, mode, runtime: { kind: 'agent', runtime: 'codex' },
    policy: mode === 'research'
      ? { read: { scope: 'inputs-only' }, write: { scope: 'none' }, tools: { allow: [], mcpServers: [] }, network: 'off', recall: 'off' }
      : { read: { scope: 'workspace' }, write: { scope: 'workspace' }, tools: { allow: [], mcpServers: [] }, network: 'on', recall: 'off' },
    inputs: [{ inputId, displayName: `${inputId}.txt`, contentHash: sha(text), snapshotId: `node:${sha(text).slice(7)}`, payload: 'text', reason: 'attached', size: { bytes: Buffer.byteLength(text) }, source: { kind: 'attachment', nodeId: 'n', attachmentId: inputId } }],
    messages: [],
  };
}
const treeOf = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => fs.statSync(path.join(dir, n)).isFile());

for (const [mode, capabilities] of [['workspace', null], ['research', SUPPORTED]]) {
  test(`[T27] two runs in one folder, ${mode}: each has a directory of its own, holding only its own`, async () => {
    const cwd = fs.mkdtempSync(path.join(base, 'cwd-'));
    const a = await materializeRun(cwd, envelope('run_a', 'in_a', 'A_ONLY_K7\n', mode), { in_a: Buffer.from('A_ONLY_K7\n').toString('base64') }, {}, capabilities);
    const b = await materializeRun(cwd, envelope('run_b', 'in_b', 'B_ONLY_Q9\n', mode), { in_b: Buffer.from('B_ONLY_Q9\n').toString('base64') }, {}, capabilities);
    assert.equal(a.ok, true, a.message);
    assert.equal(b.ok, true, b.message);
    assert.notEqual(a.dir, b.dir);
    const contentsOf = (dir) => treeOf(path.join(cwd, dir, 'materials')).map((f) => fs.readFileSync(path.join(cwd, dir, 'materials', f), 'utf8')).join();
    assert.match(contentsOf(a.dir), /A_ONLY_K7/);
    assert.doesNotMatch(contentsOf(a.dir), /B_ONLY_Q9/);
    assert.match(contentsOf(b.dir), /B_ONLY_Q9/);
    assert.doesNotMatch(contentsOf(b.dir), /A_ONLY_K7/);
  });
}

test('[T27] an input whose content is not what the run was prepared with is not written', async () => {
  const cwd = fs.mkdtempSync(path.join(base, 'cwd-'));
  const answer = await materializeRun(cwd, envelope('run_c', 'in_c', 'WHAT_WAS_FROZEN\n'), { in_c: Buffer.from('SOMETHING_ELSE\n').toString('base64') });
  assert.equal(answer.ok, false);
  assert.match(answer.code, /hash|changed|mismatch|content/i);
  assert.equal(fs.existsSync(path.join(cwd, '.thoughtdag', 'runs', 'run_c', 'materials', 'in_c.txt')), false);
});
