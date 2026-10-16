// What a run leaves in a workspace whose files it read: its record, beside
// the snapshots it was given and apart from them. A record is written whole
// or not at all; after a crash, the records and the snapshots are checked
// against each other, and a run that never said how it ended is not taken
// to have ended. Cleaning up removes only snapshots no record holds, and
// only once they are old enough that no run can still be on its way to
// recording them. On real temp folders; nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, entryIdOf, leftovers } = require('./helpers/workspace-fixture.cjs');

const setup = fixture(test, 'run-records');
const HOUR = 60 * 60 * 1000;
const snapshotFile = (project, snapshotId) => path.join(project, '.thoughtdag', 'snapshots', snapshotId.slice('snap_'.length));
const recordFile = (project, runId) => path.join(project, '.thoughtdag', 'runs', runId, 'record.json');
const age = (file, ms) => { const at = new Date(Date.now() - ms); fs.utimesSync(file, at, at); };

/** A workspace with files frozen as a run would freeze them. */
async function frozen(files) {
  const made = await setup();
  const kept = {};
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(made.at(rel)), { recursive: true });
    fs.writeFileSync(made.at(rel), content);
    const record = await made.service.registerEntry(made.workspace.workspaceId, entryIdOf(rel));
    kept[rel] = { fileId: record.fileId, ...(await made.service.freezeFile(record.fileId)) };
  }
  return { ...made, kept };
}
const recordOf = (runId, inputs, more = {}) => ({
  schemaVersion: '1', runId, graphId: 'canvas-1', taskNodeId: 'n1', targetId: 'target_1', targetRevision: 'rev_1',
  inputDigest: 'sha256:' + 'a'.repeat(64), executionDigest: 'sha256:' + 'b'.repeat(64), graphRevision: 'sha256:' + 'c'.repeat(64),
  runtime: { kind: 'provider', runtime: null, connectionRef: 'p', model: 'p/m', effort: null, capabilityVersion: null },
  inputs: inputs.map((k, i) => ({ inputId: `in_${i}`, fileId: k.fileId, snapshotId: k.snapshotId, contentHash: k.contentHash })),
  nativeBinding: null, output: null, state: 'prepared', preparedAt: '2026-10-16T00:00:00.000Z', endedAt: null,
  ...more,
});

test('[T13] a run\'s record is written whole into the workspace whose files it read, and read back as written', async () => {
  const { service, workspace, project, kept } = await frozen({ 'notes/a.md': 'A_TEXT\n' });
  const record = recordOf('run_1', [kept['notes/a.md']]);
  await service.recordRun(workspace.workspaceId, record);
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile(project, 'run_1'), 'utf8')), record);
  // how it ended replaces how it began, whole
  const ended = { ...record, state: 'completed', output: { versionIndex: 0, chars: 12 }, endedAt: '2026-10-16T00:01:00.000Z' };
  await service.recordRun(workspace.workspaceId, ended);
  assert.deepEqual(JSON.parse(fs.readFileSync(recordFile(project, 'run_1'), 'utf8')), ended);
  assert.deepEqual(leftovers(path.dirname(recordFile(project, 'run_1'))), []);
  assert.deepEqual((await service.readRuns(workspace.workspaceId)).map((r) => [r.runId, r.state]), [['run_1', 'completed']]);
});

test('[T13] what is not a run record is refused, and nothing is written', async () => {
  const { service, workspace, project, kept } = await frozen({ 'notes/a.md': 'A_TEXT\n' });
  const good = recordOf('run_1', [kept['notes/a.md']]);
  for (const bad of [
    { ...good, runId: '../escape' },
    { ...good, runId: 'run_../../x' },
    { ...good, state: 'finished-somehow' },
    { ...good, inputs: [{ inputId: 'in_0', snapshotId: '../../etc', contentHash: 'sha256:' + 'a'.repeat(64) }] },
    { ...good, inputs: Array.from({ length: 201 }, (_, i) => ({ inputId: `in_${i}`, snapshotId: kept['notes/a.md'].snapshotId, contentHash: kept['notes/a.md'].contentHash })) },
    { ...good, graphId: 'x'.repeat(300 * 1024) },
  ]) {
    await assert.rejects(service.recordRun(workspace.workspaceId, bad), (e) => e.code === 'invalid-request', JSON.stringify(bad).slice(0, 80));
  }
  assert.ok(!fs.existsSync(path.join(project, '.thoughtdag', 'runs')));
});

test('[T13] after a crash, the records and the snapshots are checked against each other, and a run that never said how it ended is unknown', async () => {
  const made = await frozen({ 'a.md': 'KEPT_A\n', 'b.md': 'KEPT_B\n', 'c.md': 'KEPT_C\n' });
  const { service, workspace, project, kept } = made;
  await service.recordRun(workspace.workspaceId, recordOf('run_open', [kept['a.md']], { state: 'running' }));
  await service.recordRun(workspace.workspaceId, recordOf('run_missing', [kept['b.md']], { state: 'completed' }));
  await service.recordRun(workspace.workspaceId, recordOf('run_damaged', [kept['c.md']], { state: 'failed' }));
  fs.rmSync(snapshotFile(project, kept['b.md'].snapshotId));
  fs.chmodSync(snapshotFile(project, kept['c.md'].snapshotId), 0o644);
  fs.writeFileSync(snapshotFile(project, kept['c.md'].snapshotId), 'TAMPERED');
  // the shell starts again over the same state
  const again = made.start();
  const report = await again.reconcileRuns(workspace.workspaceId);
  const byRun = Object.fromEntries(report.runs.map((r) => [r.runId, r]));
  assert.deepEqual(byRun.run_open, { runId: 'run_open', state: 'unknown', recorded: 'running', missing: [], damaged: [] });
  assert.deepEqual(byRun.run_missing, { runId: 'run_missing', state: 'completed', recorded: 'completed', missing: [kept['b.md'].snapshotId], damaged: [] });
  assert.deepEqual(byRun.run_damaged, { runId: 'run_damaged', state: 'failed', recorded: 'failed', missing: [], damaged: [kept['c.md'].snapshotId] });
  assert.deepEqual(report.unreadable, []);
});

test('[T13] cleaning up keeps every snapshot a record holds, however old, and what is too new to be sure of', async () => {
  const { service, workspace, project, kept } = await frozen({ 'held.md': 'HELD\n', 'loose.md': 'LOOSE\n', 'new.md': 'NEW\n' });
  await service.recordRun(workspace.workspaceId, recordOf('run_1', [kept['held.md']], { state: 'completed' }));
  age(snapshotFile(project, kept['held.md'].snapshotId), 90 * 24 * HOUR);
  age(snapshotFile(project, kept['loose.md'].snapshotId), 90 * 24 * HOUR);
  const result = await service.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR });
  assert.deepEqual(result, { removed: [kept['loose.md'].snapshotId], refused: null });
  assert.ok(fs.existsSync(snapshotFile(project, kept['held.md'].snapshotId)));
  assert.ok(fs.existsSync(snapshotFile(project, kept['new.md'].snapshotId)));
  assert.equal(await service.readSnapshot(workspace.workspaceId, kept['held.md'].snapshotId).then(String), 'HELD\n');
});

test('[T13] a snapshot frozen again is new again: a run on its way to recording it does not lose it', async () => {
  const { service, workspace, project, kept } = await frozen({ 'again.md': 'AGAIN\n' });
  age(snapshotFile(project, kept['again.md'].snapshotId), 90 * 24 * HOUR);
  const twice = await service.freezeFile(kept['again.md'].fileId);
  assert.equal(twice.snapshotId, kept['again.md'].snapshotId);
  assert.deepEqual(await service.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR }), { removed: [], refused: null });
  assert.ok(fs.existsSync(snapshotFile(project, kept['again.md'].snapshotId)));
});

test('[T13] when a record cannot be read, nothing is cleaned up: what it holds cannot be known', async () => {
  const { service, workspace, project, kept } = await frozen({ 'loose.md': 'LOOSE\n' });
  age(snapshotFile(project, kept['loose.md'].snapshotId), 90 * 24 * HOUR);
  fs.mkdirSync(path.dirname(recordFile(project, 'run_bad')), { recursive: true });
  fs.writeFileSync(recordFile(project, 'run_bad'), '{ not json');
  assert.deepEqual(await service.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR }), { removed: [], refused: 'unreadable-record' });
  assert.ok(fs.existsSync(snapshotFile(project, kept['loose.md'].snapshotId)));
  assert.deepEqual((await service.reconcileRuns(workspace.workspaceId)).unreadable, ['run_bad']);
});

// ── through the door the page asks at ──

const { createProviderRegistry } = require('../../runtime/workspace/providers/provider-registry.cjs');
const { createWorkspaceDoor, watchingThrough } = require('../../runtime/workspace/door.cjs');
const { createSubscriptionHub } = require('../../runtime/workspace/subscriptions.cjs');

test('[T13] the page records runs and asks for them back at the door, and cannot shorten the grace a snapshot is kept for', async () => {
  const made = await frozen({ 'held.md': 'HELD\n', 'loose.md': 'LOOSE\n' });
  const providers = createProviderRegistry({ service: made.service, providers: {}, remote: { workspaces: async () => [], workspaceOfFile: async () => null } });
  const hub = createSubscriptionHub({ service: watchingThrough(providers), send: () => {} });
  const door = createWorkspaceDoor({ service: made.service, providers, canvasFolder: async () => made.base, showInFileManager: () => {}, hub });
  const ask = (channel, ...args) => door[`workspace:${channel}`]({ senderId: 7 }, ...args);
  const id = made.workspace.workspaceId;
  await ask('record-run', id, recordOf('run_door', [made.kept['held.md']], { state: 'completed' }));
  assert.deepEqual((await ask('read-runs', id)).map((r) => r.runId), ['run_door']);
  assert.deepEqual((await ask('reconcile-runs', id)).runs.map((r) => [r.runId, r.state]), [['run_door', 'completed']]);
  await assert.rejects(ask('record-run', id, { runId: '../x' }), (e) => e.code === 'invalid-request');
  // half an hour old: a page asking for no grace at all still gets the hour
  age(snapshotFile(made.project, made.kept['loose.md'].snapshotId), HOUR / 2);
  assert.deepEqual(await ask('collect-snapshots', id, { graceMs: 0 }), { removed: [], refused: null });
  age(snapshotFile(made.project, made.kept['loose.md'].snapshotId), 2 * HOUR);
  assert.deepEqual(await ask('collect-snapshots', id, { graceMs: 0 }), { removed: [made.kept['loose.md'].snapshotId], refused: null });
});
