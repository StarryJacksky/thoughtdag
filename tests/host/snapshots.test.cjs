// Freezing a file for a run: its content as it is at that moment, kept
// where the workspace keeps its own records, under its own hash, never
// changed and never replaced. What a run was given can be read back
// afterwards, whatever happened to the file since. On real temp folders;
// nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { createProviderRegistry } = require('../../runtime/workspace/providers/provider-registry.cjs');
const { createWorkspaceDoor, watchingThrough } = require('../../runtime/workspace/door.cjs');
const { createSubscriptionHub } = require('../../runtime/workspace/subscriptions.cjs');

const setup = fixture(test, 'snapshots');

async function withDoor() {
  const made = await setup();
  const providers = createProviderRegistry({ service: made.service, providers: {}, remote: { workspaces: async () => [], workspaceOfFile: async () => null } });
  const hub = createSubscriptionHub({ service: watchingThrough(providers), send: () => {} });
  const door = createWorkspaceDoor({ service: made.service, providers, canvasFolder: async () => made.base, showInFileManager: () => {}, hub });
  const ask = (channel, ...args) => door[`workspace:${channel}`]({ senderId: 7 }, ...args);
  return { ...made, ask };
}
const snapshotsOf = (project) => path.join(project, '.thoughtdag', 'snapshots');

test('a file frozen for a run is kept as it was, and is read back as it was after the file changes', async () => {
  const { ask, at, open, project } = await withDoor();
  const a = await open('notes/a.md');
  const frozen = await ask('freeze-file', a.record.fileId);
  assert.equal(frozen.contentHash, sha('FIRST_TEXT_B3\n'));
  assert.equal(frozen.representation, 'text');
  assert.equal(frozen.payload, 'FIRST_TEXT_B3\n');
  assert.match(frozen.snapshotId, /^snap_[0-9a-f]{64}$/);
  // the file changes, and is even trashed: the snapshot is what the run was given
  fs.writeFileSync(at('notes/a.md'), 'CHANGED_AFTER_THE_RUN\n');
  const again = await ask('read-snapshot', a.record.workspaceId, frozen.snapshotId);
  assert.equal(again.payload, 'FIRST_TEXT_B3\n');
  assert.equal(again.contentHash, frozen.contentHash);
  // kept in the workspace's own records, out of reach of the file door
  assert.ok(fs.existsSync(path.join(snapshotsOf(project), frozen.snapshotId.slice('snap_'.length))));
});

test('the same content frozen twice is one snapshot; other content is another', async () => {
  const { ask, at, open, project } = await withDoor();
  const a = await open('notes/a.md');
  const one = await ask('freeze-file', a.record.fileId);
  const two = await ask('freeze-file', a.record.fileId);
  assert.equal(two.snapshotId, one.snapshotId);
  fs.writeFileSync(at('notes/a.md'), 'SECOND_TEXT\n');
  const three = await ask('freeze-file', a.record.fileId);
  assert.notEqual(three.snapshotId, one.snapshotId);
  assert.equal(three.payload, 'SECOND_TEXT\n');
  assert.equal(fs.readdirSync(snapshotsOf(project)).filter((n) => /^[0-9a-f]{64}$/.test(n)).length, 2);
});

test('a binary file is frozen as its bytes', async () => {
  const { ask, at, service, workspace, project } = await withDoor();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
  fs.writeFileSync(at('papers/pixel.png'), bytes);
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('papers/pixel.png'));
  const frozen = await ask('freeze-file', record.fileId);
  assert.equal(frozen.representation, 'bytes');
  assert.deepEqual(Buffer.from(frozen.payload), bytes);
  assert.equal(frozen.contentHash, sha(bytes));
  void project;
});

test('a snapshot that does not hash to its name is not read; one that is not there is not either', async () => {
  const { ask, open, project } = await withDoor();
  const a = await open('notes/a.md');
  const frozen = await ask('freeze-file', a.record.fileId);
  fs.writeFileSync(path.join(snapshotsOf(project), frozen.snapshotId.slice('snap_'.length)), 'TAMPERED\n');
  await assert.rejects(ask('read-snapshot', a.record.workspaceId, frozen.snapshotId), { code: 'not-found' });
  await assert.rejects(ask('read-snapshot', a.record.workspaceId, `snap_${'0'.repeat(64)}`), { code: 'not-found' });
  for (const bad of ['../resources.json', 'snap_../../x', 'snap_ZZ', '']) {
    await assert.rejects(ask('read-snapshot', a.record.workspaceId, bad), { code: 'invalid-request' }, bad);
  }
});

test('a lost file cannot be frozen, nor one too large to send to the page', async () => {
  const { ask, at, open, service } = await withDoor();
  const a = await open('notes/a.md');
  fs.rmSync(at('notes/a.md'));
  await service.reconcile(a.record.fileId);
  await assert.rejects(ask('freeze-file', a.record.fileId), { code: 'lost' });
  const big = await open('papers/keep.md');
  fs.writeFileSync(at('papers/keep.md'), Buffer.alloc(8 * 1024 * 1024 + 1, 'a'));
  await assert.rejects(ask('freeze-file', big.record.fileId), { code: 'too-large' });
});

test('a snapshot is written whole: the name it is read by is only ever given to complete content', async () => {
  const { ask, open, project } = await withDoor();
  const a = await open('notes/a.md');
  const frozen = await ask('freeze-file', a.record.fileId);
  const left = fs.readdirSync(snapshotsOf(project)).filter((n) => n.includes('.tdag-'));
  assert.deepEqual(left, [], 'nothing half-written is left behind');
  assert.equal(fs.readFileSync(path.join(snapshotsOf(project), frozen.snapshotId.slice('snap_'.length)), 'utf8'), 'FIRST_TEXT_B3\n');
});
