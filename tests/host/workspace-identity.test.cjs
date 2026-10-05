// Which folder a workspace id leads to, and which file a file id leads to,
// when folders are copied or moved with the file manager and when a name is
// used again after its file was trashed. Real temp folders; every check
// looks at what is on disk, not only at the ids that came back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, entryIdOf, registryOf } = require('./helpers/workspace-fixture.cjs');

const setup = fixture(test, 'identity');
const names = (entries) => entries.map((e) => e.name).sort();

test('a copy of an open workspace folder is a workspace of its own: its listing, its new files and its file identities are the copy\'s', async () => {
  const { service, start, workspace, project, base, choose, open, request } = await setup();
  const original = await open('notes/a.md');
  await service.putDraft(original.record.fileId, { text: 'TYPED_BEFORE_THE_COPY_D2\n', baseRevision: original.revision });
  const copyDir = path.join(base, 'copy-of-project');
  fs.cpSync(project, copyDir, { recursive: true });
  fs.writeFileSync(path.join(project, 'original-only.md'), 'ORIGINAL_ONLY_K1\n');
  fs.writeFileSync(path.join(copyDir, 'copy-only.md'), 'COPY_ONLY_K2\n');

  const copy = await choose(copyDir);
  assert.notEqual(copy.workspaceId, workspace.workspaceId, 'the copy has an id of its own');
  assert.ok(names(await service.listChildren(copy.workspaceId)).includes('copy-only.md'));
  assert.ok(!names(await service.listChildren(copy.workspaceId)).includes('original-only.md'));
  assert.ok(names(await service.listChildren(workspace.workspaceId)).includes('original-only.md'));

  const made = await service.createFile({ ...request('op-copy'), workspaceId: copy.workspaceId });
  assert.ok(fs.existsSync(path.join(copyDir, made.relativePath)), 'a file created in the copy is in the copy');
  assert.ok(!fs.existsSync(path.join(project, made.relativePath)));

  // the file that was registered before the copy was made: one identity per folder
  const inCopy = await service.registerEntry(copy.workspaceId, entryIdOf('notes/a.md'));
  assert.notEqual(inCopy.fileId, original.record.fileId);
  assert.equal(inCopy.workspaceId, copy.workspaceId);
  assert.equal(await service.locate(original.record.fileId), path.join(project, 'notes', 'a.md'));
  assert.equal(await service.locate(inCopy.fileId), path.join(copyDir, 'notes', 'a.md'));
  // unsaved typing was copied with the folder: each folder has it under its own file's identity
  assert.equal((await service.getDraft(inCopy.fileId))?.text, 'TYPED_BEFORE_THE_COPY_D2\n');
  assert.equal((await service.getDraft(original.record.fileId))?.text, 'TYPED_BEFORE_THE_COPY_D2\n');
  await service.clearDraft(inCopy.fileId);
  assert.equal((await service.getDraft(original.record.fileId))?.text, 'TYPED_BEFORE_THE_COPY_D2\n');
  fs.writeFileSync(path.join(copyDir, 'notes', 'a.md'), 'EDITED_IN_COPY_K3\n');
  assert.equal((await service.readText(original.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.equal((await service.readText(inCopy.fileId)).text, 'EDITED_IN_COPY_K3\n');

  // the folders keep their own ids on disk, and a restart still tells them apart
  assert.equal(JSON.parse(fs.readFileSync(path.join(copyDir, '.thoughtdag', 'workspace.json'), 'utf8')).workspaceId, copy.workspaceId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, '.thoughtdag', 'workspace.json'), 'utf8')).workspaceId, workspace.workspaceId);
  assert.equal(registryOf(copyDir).workspaceId, copy.workspaceId);
  const restarted = start();
  assert.equal(await restarted.locate(original.record.fileId), path.join(project, 'notes', 'a.md'));
  assert.equal(await restarted.locate(inCopy.fileId), path.join(copyDir, 'notes', 'a.md'));
  assert.deepEqual((await restarted.listWorkspaces()).map((w) => w.workspaceId).sort(), [workspace.workspaceId, copy.workspaceId].sort());
});

test('a workspace folder that was moved is the same workspace at its new place: one entry, working listing, the same file identities', async () => {
  const { service, start, workspace, project, base, choose, open, request } = await setup();
  const before = await open('notes/a.md');
  const movedDir = path.join(base, 'moved-project');
  fs.renameSync(project, movedDir);

  const moved = await choose(movedDir);
  assert.equal(moved.workspaceId, workspace.workspaceId);
  assert.deepEqual((await service.listWorkspaces()).map((w) => [w.workspaceId, w.displayName]), [[workspace.workspaceId, 'moved-project']]);
  assert.deepEqual(names(await service.listChildren(workspace.workspaceId)), ['notes', 'papers']);
  assert.equal(await service.locate(before.record.fileId), path.join(movedDir, 'notes', 'a.md'));
  assert.equal((await service.readText(before.record.fileId)).text, 'FIRST_TEXT_B3\n');
  const made = await service.createFile(request('op-after-move'));
  assert.ok(fs.existsSync(path.join(movedDir, made.relativePath)));

  const restarted = start();
  assert.equal((await restarted.listWorkspaces()).length, 1);
  assert.equal(await restarted.locate(before.record.fileId), path.join(movedDir, 'notes', 'a.md'));
});

test('a name used again after its file was trashed is a new file with a new identity; the old reference stays lost', async () => {
  const { service, start, request, at } = await setup();
  const first = await service.createFile(request('op-1'));
  assert.equal(first.relativePath, 'Untitled-001.md');
  await service.saveText(first.fileId, first.revision, 'OLD_DOCUMENT_V1\n', 'op-save');
  await service.trashFile(first.fileId, 'op-trash');

  const second = await service.createFile(request('op-2'));
  assert.equal(second.relativePath, 'Untitled-001.md', 'the name is free again');
  assert.notEqual(second.fileId, first.fileId);
  assert.equal(second.status, 'ready');
  assert.equal((await service.readText(second.fileId)).text, '');
  assert.equal((await service.resourceRecord(first.fileId)).status, 'missing');
  await assert.rejects(service.readText(first.fileId), { code: 'lost' });
  assert.equal(fs.readFileSync(at('Untitled-001.md'), 'utf8'), '');

  // a listing names the file that is there now, and a rescan does not hand the new file to the old identity
  const listed = (await service.listChildren(second.workspaceId)).find((e) => e.name === 'Untitled-001.md');
  assert.equal(listed.fileId, second.fileId);
  await service.rescanWorkspace(second.workspaceId);
  assert.equal((await service.resourceRecord(first.fileId)).status, 'missing');
  const restarted = start();
  assert.equal((await restarted.resourceRecord(second.fileId)).status, 'ready');
  assert.equal((await restarted.resourceRecord(first.fileId)).status, 'missing');
});

test('a file put back where it was, the very same file, is its old identity again whichever way it is first noticed', async () => {
  const { service, open, at, base, workspace } = await setup();
  const a = await open('notes/a.md');
  const parked = path.join(base, 'parked-a.md');
  fs.renameSync(at('notes/a.md'), parked);
  assert.equal((await service.reconcile(a.record.fileId)).status, 'missing');
  // put back: the same file at its old path, first noticed by someone asking for the file at that path
  fs.renameSync(parked, at('notes/a.md'));
  const again = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/a.md'));
  assert.equal(again.fileId, a.record.fileId);
  assert.equal(again.status, 'ready');
  assert.equal((await service.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
});
