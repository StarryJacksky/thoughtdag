// What an agent is given on disk, written from the run's envelope and from
// nothing else: each input under a name of its own, the part selected and
// not the whole, bytes that hash to what was frozen, and a map of it all.
// What the person left out is never written; a run whose inputs are too
// large is refused before anything is. And the policy a run is to run under
// is checked against what the runtime is known to be able to enforce:
// what is not known to be enforceable is not promised. On real temp
// folders; nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fixture, sha, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { materialize, MAX_MATERIAL_BYTES } = require('../../runtime/execution/materialize.cjs');
const { verifyPolicy } = require('../../runtime/execution/policy.cjs');

const setup = fixture(test, 'materialize');
const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const runDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-run-'));

/** A workspace with files frozen, and how the materializer reads its snapshots. */
async function withSnapshots(files) {
  const made = await setup();
  const frozen = {};
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(made.at(rel)), { recursive: true });
    fs.writeFileSync(made.at(rel), content);
    const record = await made.service.registerEntry(made.workspace.workspaceId, entryIdOf(rel));
    const f = await made.service.freezeFile(record.fileId);
    frozen[rel] = { fileId: record.fileId, snapshotId: f.snapshotId, contentHash: f.contentHash };
  }
  const readSnapshotOfFile = async (fileId, snapshotId) => made.service.readSnapshot((await made.service.resourceRecord(fileId)).workspaceId, snapshotId);
  return { ...made, frozen, readSnapshotOfFile };
}
const resourceInput = (inputId, f, displayName, selector = { kind: 'document' }) => ({
  inputId, displayName, contentHash: f.contentHash, snapshotId: f.snapshotId, payload: 'text', reason: 'wired',
  size: { bytes: 1 }, source: { kind: 'resource', ref: { fileId: f.fileId, selector, version: { kind: 'snapshot', snapshotId: f.snapshotId }, payload: 'text' } },
});
const nodeInput = (inputId, displayName, bytes) => ({
  inputId, displayName, contentHash: sha256(bytes), snapshotId: `node:${sha256(bytes).slice(7)}`, payload: 'text', reason: 'attached',
  size: { bytes: bytes.length }, source: { kind: 'attachment', nodeId: 'n1', attachmentId: inputId },
});

test('[T12] each input is written under a name of its own, from its snapshot, and the map says where', async () => {
  const { frozen, readSnapshotOfFile } = await withSnapshots({ 'a/notes.md': 'FROM_A\n', 'b/notes.md': 'FROM_B\n' });
  const dir = runDir();
  const receipt = await materialize({ runId: 'run_1', inputs: [resourceInput('in_a', frozen['a/notes.md'], 'notes.md'), resourceInput('in_b', frozen['b/notes.md'], 'notes.md')] }, dir, { readSnapshotOfFile });
  assert.equal(receipt.entries.length, 2, 'two files of one name are two files');
  const [a, b] = receipt.entries;
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(path.join(dir, a.path), 'utf8'), 'FROM_A\n');
  assert.equal(fs.readFileSync(path.join(dir, b.path), 'utf8'), 'FROM_B\n');
  for (const e of receipt.entries) {
    assert.equal(sha256(fs.readFileSync(path.join(dir, e.path))), e.writtenHash, 'what is on disk is what the receipt says');
    assert.equal(e.writtenHash, e.sourceHash, 'a whole file is written as frozen');
    assert.equal(e.permission, 'read');
  }
  const map = JSON.parse(fs.readFileSync(path.join(dir, receipt.manifest), 'utf8'));
  assert.deepEqual(map.inputs.map((x) => [x.inputId, x.path, x.contentHash]), receipt.entries.map((e) => [e.inputId, e.path, e.sourceHash]));
  // the run directory holds the materials and their map, and nothing else
  assert.deepEqual(fs.readdirSync(dir).sort(), ['materials']);
});

test('[T12] a passage selected is written as the passage, never the whole file', async () => {
  const { frozen, readSnapshotOfFile } = await withSnapshots({ 'paper.md': 'WHOLE_FILE_INTRO\nThe method uses a trimmed mean here.\nWHOLE_FILE_OUTRO\n' });
  const dir = runDir();
  const passage = { kind: 'text', quote: 'trimmed mean', prefix: 'uses a ', suffix: ' here' };
  const receipt = await materialize({ runId: 'run_1', inputs: [resourceInput('in_p', frozen['paper.md'], 'paper.md', passage)] }, dir, { readSnapshotOfFile });
  const written = fs.readFileSync(path.join(dir, receipt.entries[0].path), 'utf8');
  assert.equal(written, 'trimmed mean');
  assert.equal(receipt.entries[0].sourceHash, frozen['paper.md'].contentHash);
  assert.equal(receipt.entries[0].writtenHash, sha256(Buffer.from('trimmed mean')));
  const everything = fs.readdirSync(path.join(dir, 'materials')).map((n) => fs.readFileSync(path.join(dir, 'materials', n), 'utf8')).join('\n');
  assert.ok(!everything.includes('WHOLE_FILE_INTRO'));
});

test('[T12] what the person left out is not written: only the envelope\'s inputs are', async () => {
  const { frozen, readSnapshotOfFile } = await withSnapshots({ 'keep.md': 'KEEP_THIS\n', 'secret.md': 'EXCLUDED_SECRET_K7\n' });
  const dir = runDir();
  // the envelope lists keep.md as an input and secret.md as left out: its content is nowhere in the envelope
  await materialize({ runId: 'run_1', inputs: [resourceInput('in_k', frozen['keep.md'], 'keep.md')] }, dir, { readSnapshotOfFile });
  const all = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else all.push(fs.readFileSync(p, 'utf8')); } };
  walk(dir);
  assert.ok(!all.join('\n').includes('EXCLUDED_SECRET_K7'));
});

test('[T12] bytes that do not hash to what was frozen are not written, and nothing of the run is', async () => {
  const { frozen, readSnapshotOfFile } = await withSnapshots({ 'a.md': 'A\n' });
  const dir = runDir();
  const held = Buffer.from('HELD_ON_THE_CANVAS');
  await assert.rejects(materialize({ runId: 'run_1', inputs: [resourceInput('in_a', frozen['a.md'], 'a.md'), nodeInput('in_n', 'note.txt', held)] }, dir, { readSnapshotOfFile, provided: { in_n: Buffer.from('SOMETHING_ELSE').toString('base64') } }), { code: 'hash-mismatch' });
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written');
  // given right, it is written
  const receipt = await materialize({ runId: 'run_1', inputs: [nodeInput('in_n', 'note.txt', held)] }, dir, { readSnapshotOfFile, provided: { in_n: held.toString('base64') } });
  assert.equal(fs.readFileSync(path.join(dir, receipt.entries[0].path), 'utf8'), 'HELD_ON_THE_CANVAS');
});

test('[T12] inputs too large in all are refused before anything is written', async () => {
  const { readSnapshotOfFile } = await withSnapshots({});
  const dir = runDir();
  const big = Buffer.alloc(1024, 'x');
  await assert.rejects(materialize({ runId: 'run_1', inputs: [nodeInput('in_1', 'a.txt', big), nodeInput('in_2', 'b.txt', big)] }, dir, { readSnapshotOfFile, provided: { in_1: big.toString('base64'), in_2: big.toString('base64') }, maxBytes: 1500 }), { code: 'too-large' });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(MAX_MATERIAL_BYTES >= 8 * 1024 * 1024);
});

test('[T12] a name an input gives cannot place it outside the run directory', async () => {
  const { readSnapshotOfFile } = await withSnapshots({});
  const dir = runDir();
  const bytes = Buffer.from('X');
  const receipt = await materialize({ runId: 'run_1', inputs: [nodeInput('in_1', '../../../etc/passwd', bytes), nodeInput('in_2', '/abs/path.txt', bytes), nodeInput('in_3', 'C:\\\\win.txt', bytes)] }, dir, { readSnapshotOfFile, provided: { in_1: bytes.toString('base64'), in_2: bytes.toString('base64'), in_3: bytes.toString('base64') } });
  for (const e of receipt.entries) {
    const full = path.resolve(dir, e.path);
    assert.ok(full.startsWith(path.join(dir, 'materials') + path.sep), e.path);
    assert.equal(path.dirname(full), path.join(dir, 'materials'));
  }
});

test('[T13] a run directory that holds the run\'s own record is written into beside it', async () => {
  const { readSnapshotOfFile } = await withSnapshots({});
  const dir = runDir();
  fs.writeFileSync(path.join(dir, 'record.json'), '{}');
  const bytes = Buffer.from('X');
  const receipt = await materialize({ runId: 'run_1', inputs: [nodeInput('in_1', 'a.txt', bytes)] }, dir, { readSnapshotOfFile, provided: { in_1: bytes.toString('base64') } });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['materials', 'record.json']);
  assert.equal(receipt.entries.length, 1);
});

test('[T12] a run directory that already holds something is not written into', async () => {
  const { readSnapshotOfFile } = await withSnapshots({});
  const dir = runDir();
  fs.writeFileSync(path.join(dir, 'left.txt'), 'x');
  const bytes = Buffer.from('X');
  await assert.rejects(materialize({ runId: 'run_1', inputs: [nodeInput('in_1', 'a.txt', bytes)] }, dir, { readSnapshotOfFile, provided: { in_1: bytes.toString('base64') } }), { code: 'not-empty' });
});

// ── the policy a run runs under ───────────────────────────────────────

const envelope = (mode, runtime, policy = {}) => ({
  mode,
  runtime,
  policy: { read: { scope: mode === 'research' ? 'inputs-only' : 'workspace', inputIds: [] }, write: { scope: 'none' }, tools: { allow: [], mcpServers: [] }, network: 'off', recall: 'off', budget: { maxInputTokens: 1, reservedOutputTokens: 1, maxToolCalls: 1, maxWallTimeSeconds: 1 }, ...policy },
});
const agent = { kind: 'agent', runtime: 'codex', connectionRef: 'local:codex', model: 'codex/x', effort: null, capabilityVersion: null };
const api = { kind: 'provider', runtime: null, connectionRef: 'p', model: 'p/m', effort: null, capabilityVersion: null };
const caps = (over = {}) => ({ runtime: 'codex', binaryVersion: '1', probedAt: '2026-10-16T00:00:00Z', capabilities: { fresh: 'supported', resume: 'supported', forkAtCompletedTurn: 'unknown', observeState: 'unknown', cancel: 'supported', approvals: 'supported', readOnlyRoots: 'unknown', networkRestriction: 'unknown', autoContextControl: 'unknown', ...over } });

test('[T12] research by an agent is refused while the runtime is not known to keep it to its inputs, offline and without its own memory', () => {
  const r = verifyPolicy(envelope('research', agent), null);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked.sort(), ['autoContextControl', 'networkRestriction', 'readOnlyRoots']);
  assert.equal(verifyPolicy(envelope('research', agent), caps()).ok, false);
  assert.equal(verifyPolicy(envelope('research', agent), caps({ readOnlyRoots: 'supported', networkRestriction: 'unsupported', autoContextControl: 'supported' })).ok, false);
  assert.deepEqual(verifyPolicy(envelope('research', agent), caps({ readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'supported' })), { ok: true, blocked: [], notice: null });
});

test('[T12] research through an API is given its messages only: no tools, no network, no recall', () => {
  assert.deepEqual(verifyPolicy(envelope('research', api), null), { ok: true, blocked: [], notice: null });
  assert.deepEqual(verifyPolicy(envelope('research', api, { tools: { allow: ['web_search'], mcpServers: [] }, network: 'on' }), null).blocked.sort(), ['network', 'tools']);
  assert.deepEqual(verifyPolicy(envelope('research', api, { recall: 'auto' }), null).blocked, ['recall']);
});

test('[T12] working mode runs, and says that an agent\'s tools can read more than its inputs', () => {
  assert.deepEqual(verifyPolicy(envelope('workspace', agent), null), { ok: true, blocked: [], notice: 'workspace-readable' });
  assert.deepEqual(verifyPolicy(envelope('workspace', api), null), { ok: true, blocked: [], notice: null });
});

// ── at the door: where a run's materials go, and what is refused there ──

const { materializeRun } = require('../../runtime/agents/ops.cjs');
const { pruneRuns } = require('../../runtime/execution/materialize.cjs');

test('[T12] the door writes a run\'s inputs under .thoughtdag/runs/<runId> in the working directory, as plain read-only files', async () => {
  const cwd = runDir();
  const bytes = Buffer.from('HELD');
  const answer = await materializeRun(cwd, { ...envelope('workspace', agent), runId: 'run_door', inputs: [nodeInput('in_1', 'a.txt', bytes)] }, { in_1: bytes.toString('base64') });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.dir, '.thoughtdag/runs/run_door');
  const file = path.join(cwd, answer.dir, answer.receipt.entries[0].path);
  const st = fs.lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.equal(st.mode & 0o222, 0, 'written read-only');
  assert.equal(fs.readFileSync(file, 'utf8'), 'HELD');
});

test('[T12] the door refuses research by an agent, writes nothing, and says what cannot be held', async () => {
  const cwd = runDir();
  const bytes = Buffer.from('HELD');
  const answer = await materializeRun(cwd, { ...envelope('research', agent), runId: 'run_r', inputs: [nodeInput('in_1', 'a.txt', bytes)] }, { in_1: bytes.toString('base64') });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'policy');
  assert.deepEqual(answer.blocked.sort(), ['autoContextControl', 'networkRestriction', 'readOnlyRoots']);
  assert.ok(!fs.existsSync(path.join(cwd, '.thoughtdag')));
});

test('[T12] the door refuses a run id or a working directory that could place files anywhere else', async () => {
  const cwd = runDir();
  for (const runId of ['../run_x', 'run_../../x', 'x']) {
    const answer = await materializeRun(cwd, { ...envelope('workspace', agent), runId, inputs: [] }, {});
    assert.equal(answer.code, 'invalid-envelope', runId);
  }
  assert.equal((await materializeRun('relative/dir', { ...envelope('workspace', agent), runId: 'run_1', inputs: [] }, {})).code, 'invalid-request');
  assert.ok(!fs.existsSync(path.join(cwd, '.thoughtdag')));
});

test('[T12] a file in a folder opened read-only is given as it is, only while it is what was frozen', async () => {
  const dir = runDir();
  const frozen = Buffer.from('READ_ONLY_FOLDER\n');
  const input = { ...resourceInput('in_u', { fileId: 'file_u', snapshotId: 'unkept:' + sha256(frozen).slice(7), contentHash: sha256(frozen) }, 'u.md'), snapshotId: 'unkept:' + sha256(frozen).slice(7) };
  let now = frozen;
  const readCurrentOfFile = async () => now;
  const receipt = await materialize({ runId: 'run_1', inputs: [input] }, dir, { readCurrentOfFile });
  assert.equal(fs.readFileSync(path.join(dir, receipt.entries[0].path), 'utf8'), 'READ_ONLY_FOLDER\n');
  now = Buffer.from('CHANGED_SINCE\n');
  await assert.rejects(materialize({ runId: 'run_2', inputs: [input] }, runDir(), { readCurrentOfFile }), { code: 'hash-mismatch' });
});

test('[T12] old run directories go beyond the newest ones kept, except one something else wrote into', async () => {
  const runs = runDir();
  const bytes = Buffer.from('X');
  for (let i = 0; i < 5; i++) {
    await materialize({ runId: `run_${i}`, inputs: [nodeInput('in_1', 'a.txt', bytes)] }, path.join(runs, `run_${i}`), { provided: { in_1: bytes.toString('base64') } });
  }
  fs.chmodSync(path.join(runs, 'run_1', 'materials'), 0o755);
  fs.writeFileSync(path.join(runs, 'run_1', 'materials', 'agent-wrote-this.txt'), 'x');
  fs.mkdirSync(path.join(runs, 'not-a-run'));
  // a run's record beside its materials stays when the materials go
  fs.writeFileSync(path.join(runs, 'run_2', 'record.json'), '{}');
  for (let i = 0; i < 5; i++) {
    const at = new Date(Date.UTC(2026, 9, 16, 0, i));
    fs.utimesSync(path.join(runs, `run_${i}`, 'materials'), at, at);
  }
  const removed = await pruneRuns(runs, { keep: 2 });
  assert.deepEqual(removed.sort(), ['run_0', 'run_2']);
  assert.deepEqual(fs.readdirSync(runs).sort(), ['not-a-run', 'run_1', 'run_2', 'run_3', 'run_4']);
  assert.deepEqual(fs.readdirSync(path.join(runs, 'run_2')), ['record.json']);
});
