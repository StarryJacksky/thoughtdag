// Folders as things that can be moved, renamed, copied and trashed, and the
// way back from the recovery area: a trashed file or folder put back where
// it was, and an earlier version of a file put back in place of the
// current one. Real temp folders; every check looks at the disk and at the
// identities of the files involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, entryIdOf, journalOf, journalLine, leftovers, meetingAt } = require('./helpers/workspace-fixture.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const setup = fixture(test, 'folders');
const names = (entries) => entries.map((e) => e.name).sort();
async function valid(kind, value) {
  const result = (await loadContracts()).validateDTO(kind, value);
  assert.ok(result.ok, `${kind}: ${JSON.stringify(result.errors)}`);
}
/** A workspace with a folder to move things into, and a listener that records what it hears. */
async function withArchive(options) {
  const made = await setup(options);
  fs.mkdirSync(made.at('archive'));
  fs.writeFileSync(made.at('notes/unregistered.txt'), 'NEVER_USED_U1\n');
  const heard = [];
  await made.service.subscribeWorkspace(made.workspace.workspaceId, (event) => heard.push([event.change, event.record.relativePath, event.fileId]));
  return { ...made, heard, archive: entryIdOf('archive') };
}

// ── moving and renaming ────────────────────────────────────────────────

test('a folder moved into another takes its files with it, and every file in it keeps its identity at its new place', async () => {
  const { service, start, workspace, open, at, notes, archive, heard } = await withArchive();
  const a = await open('notes/a.md');
  const moved = await service.moveFolder(workspace.workspaceId, notes, archive, 'notes', 'op-1');
  assert.equal(moved, entryIdOf('archive/notes'));
  assert.equal(fs.existsSync(at('notes')), false);
  assert.deepEqual(fs.readdirSync(at('archive/notes')).sort(), ['a.md', 'unregistered.txt']);
  assert.equal(fs.readFileSync(at('archive/notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');

  const record = await service.resourceRecord(a.record.fileId);
  assert.equal(record.relativePath, 'archive/notes/a.md');
  assert.equal(record.locator.relativePath, 'archive/notes/a.md');
  assert.equal((await service.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(heard, [['moved', 'archive/notes/a.md', a.record.fileId]]);
  // asked again it is the same answer and nothing moves twice; after a restart the file is still found
  assert.equal(await service.moveFolder(workspace.workspaceId, notes, archive, 'notes', 'op-1'), moved);
  assert.equal((await start().resourceRecord(a.record.fileId)).relativePath, 'archive/notes/a.md');
});

test('a folder renamed in place is the same folder under a new name', async () => {
  const { service, workspace, open, at, notes } = await withArchive();
  const a = await open('notes/a.md');
  assert.equal(await service.moveFolder(workspace.workspaceId, notes, undefined, 'reading-notes', 'op-1'), entryIdOf('reading-notes'));
  assert.deepEqual(names(await service.listChildren(workspace.workspaceId)), ['archive', 'papers', 'reading-notes']);
  assert.equal((await service.resourceRecord(a.record.fileId)).relativePath, 'reading-notes/a.md');
  assert.equal(fs.readFileSync(at('reading-notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
});

test('a folder is not moved onto a name that is taken, into itself, or under a name that is not portable; nothing moves', async () => {
  const { service, workspace, open, at, notes, papers } = await withArchive();
  const a = await open('notes/a.md');
  await assert.rejects(service.moveFolder(workspace.workspaceId, notes, undefined, 'papers', 'op-1'), { code: 'exists' });
  await assert.rejects(service.moveFolder(workspace.workspaceId, notes, notes, 'inside', 'op-2'), { code: 'invalid-move' });
  await assert.rejects(service.moveFolder(workspace.workspaceId, notes, papers, 'con', 'op-3'), { code: 'reserved-name' });
  await assert.rejects(service.moveFolder(workspace.workspaceId, entryIdOf('notes/a.md'), papers, 'a.md', 'op-4'), { code: 'not-a-directory' });
  await assert.rejects(service.moveFolder(workspace.workspaceId, entryIdOf('.thoughtdag'), papers, 'records', 'op-5'), { code: 'metadata-directory' });
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['a.md', 'unregistered.txt']);
  assert.deepEqual(fs.readdirSync(at('papers')), ['keep.md']);
  assert.equal((await service.resourceRecord(a.record.fileId)).relativePath, 'notes/a.md');
});

test('a save that is under way when its folder is moved still lands in the file, at the folder\'s new place', async () => {
  // the save waits at the step that puts the new content in place, long enough for the move to be asked
  const { service, workspace, open, at, notes, archive } = await withArchive({ io: meetingAt(['rename'], { count: 99, ms: 120 }) });
  const a = await open('notes/a.md');
  const [saved, moved] = await Promise.all([
    service.saveText(a.record.fileId, a.revision, 'SAVED_DURING_MOVE_V8\n', 'op-save'),
    service.moveFolder(workspace.workspaceId, notes, archive, 'notes', 'op-move'),
  ]);
  assert.equal(saved.status, 'saved');
  assert.equal(moved, entryIdOf('archive/notes'));
  assert.equal(fs.readFileSync(at('archive/notes/a.md'), 'utf8'), 'SAVED_DURING_MOVE_V8\n');
  assert.deepEqual(leftovers(at('archive/notes')), []);
  assert.equal(fs.existsSync(at('notes')), false);
});

test('a folder move cut short after the folder was renamed is finished on the next start: the files in it are found at their new place', async () => {
  const { start, workspace, open, at, project } = await withArchive();
  const a = await open('notes/a.md');
  fs.appendFileSync(journalOf(project), journalLine({ opId: 'op-1', kind: 'move-folder', phase: 'intent', from: 'notes', to: 'archive/notes' }));
  fs.renameSync(at('notes'), at('archive/notes'));
  const restarted = start();
  assert.equal(await restarted.moveFolder(workspace.workspaceId, entryIdOf('notes'), entryIdOf('archive'), 'notes', 'op-1'), entryIdOf('archive/notes'));
  assert.equal((await restarted.resourceRecord(a.record.fileId)).relativePath, 'archive/notes/a.md');
  assert.equal((await restarted.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
});

// ── copying ────────────────────────────────────────────────────────────

test('a copy of a folder is a new folder with its own files; the files in it have identities of their own', async () => {
  const { service, workspace, open, at, notes, archive } = await withArchive();
  const a = await open('notes/a.md');
  assert.equal(await service.copyFolder(workspace.workspaceId, notes, archive, 'notes-copy', 'op-1'), entryIdOf('archive/notes-copy'));
  assert.deepEqual(fs.readdirSync(at('archive/notes-copy')).sort(), ['a.md', 'unregistered.txt']);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['a.md', 'unregistered.txt']);
  const copy = await service.registerEntry(workspace.workspaceId, entryIdOf('archive/notes-copy/a.md'));
  assert.notEqual(copy.fileId, a.record.fileId);
  fs.writeFileSync(at('archive/notes-copy/a.md'), 'EDITED_COPY_W2\n');
  assert.equal((await service.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
  await assert.rejects(service.copyFolder(workspace.workspaceId, notes, archive, 'notes-copy', 'op-2'), { code: 'exists' });
  await assert.rejects(service.copyFolder(workspace.workspaceId, notes, notes, 'inside', 'op-3'), { code: 'invalid-move' });
  assert.deepEqual(leftovers(at('archive')), []);
});

// ── trashing, and the way back ─────────────────────────────────────────

test('a trashed folder, with no system trash, is kept whole in the recovery area; its files are lost until it is put back, and then they are themselves again', async () => {
  const { service, start, workspace, open, at, notes, heard } = await withArchive();
  const a = await open('notes/a.md');
  const item = await service.trashFolder(workspace.workspaceId, notes, 'op-trash');
  await valid('RecoveryItem', item);
  assert.deepEqual([item.kind, item.name, item.relativePath], ['folder', 'notes', 'notes']);
  assert.equal(fs.existsSync(at('notes')), false);
  assert.equal((await service.resourceRecord(a.record.fileId)).status, 'missing');
  await assert.rejects(service.readText(a.record.fileId), { code: 'lost' });
  assert.deepEqual(heard, [['missing', 'notes/a.md', a.record.fileId]]);

  const listed = await service.listRecovery(workspace.workspaceId);
  assert.deepEqual(listed, [item]);
  // after a restart it is still there to be put back
  assert.deepEqual(await start().listRecovery(workspace.workspaceId), [item]);

  assert.equal(await service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), notes);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['a.md', 'unregistered.txt']);
  const back = await service.resourceRecord(a.record.fileId);
  assert.deepEqual([back.status, back.relativePath], ['ready', 'notes/a.md']);
  assert.equal((await service.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(heard.slice(1), [['restored', 'notes/a.md', a.record.fileId]]);
  assert.deepEqual(await service.listRecovery(workspace.workspaceId), []);
});

test('a trashed file is listed in the recovery area and comes back as the same file', async () => {
  const { service, workspace, open, at } = await withArchive();
  const a = await open('notes/a.md');
  const receipt = await service.trashFile(a.record.fileId, 'op-trash');
  const [item] = await service.listRecovery(workspace.workspaceId);
  await valid('RecoveryItem', item);
  assert.deepEqual([item.receiptId, item.kind, item.name, item.relativePath, item.fileId], [receipt.receiptId, 'file', 'a.md', 'notes/a.md', a.record.fileId]);
  assert.equal(await service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), entryIdOf('notes/a.md'));
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal((await service.resourceRecord(a.record.fileId)).status, 'ready');
  // putting it back twice is putting it back once
  assert.equal(await service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), entryIdOf('notes/a.md'));
});

test('nothing is put back on top of what took its place, and the folder it was in is made again if it is gone', async () => {
  const { service, workspace, open, at, papers } = await withArchive();
  const a = await open('notes/a.md');
  await service.trashFile(a.record.fileId, 'op-trash');
  const [item] = await service.listRecovery(workspace.workspaceId);
  fs.writeFileSync(at('notes/a.md'), 'TOOK_ITS_PLACE_P5\n');
  await assert.rejects(service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), { code: 'exists' });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'TOOK_ITS_PLACE_P5\n');
  assert.equal((await service.listRecovery(workspace.workspaceId)).length, 1, 'it is still in the recovery area');

  // the place is cleared by moving the whole folder away: its old folder is made again for it
  await service.moveFolder(workspace.workspaceId, entryIdOf('notes'), papers, 'old-notes', 'op-move');
  assert.equal(await service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore-2'), entryIdOf('notes/a.md'));
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal(fs.readFileSync(at('papers/old-notes/a.md'), 'utf8'), 'TOOK_ITS_PLACE_P5\n');
});

test('a folder that went to the system trash is the system\'s to bring back: nothing is listed here, and its files are lost until then', async () => {
  const trashed = [];
  const { service, workspace, open, at, notes, base } = await withArchive({ trash: async (absolute) => { fs.renameSync(absolute, path.join(base, `system-trash-${trashed.push(absolute)}`)); } });
  const a = await open('notes/a.md');
  assert.equal(await service.trashFolder(workspace.workspaceId, notes, 'op-trash'), null);
  assert.deepEqual(trashed, [at('notes')]);
  assert.deepEqual(await service.listRecovery(workspace.workspaceId), []);
  assert.equal((await service.resourceRecord(a.record.fileId)).status, 'missing');
  // the system puts the folder back: the next look finds the same files
  fs.renameSync(path.join(base, 'system-trash-1'), at('notes'));
  await service.rescanWorkspace(workspace.workspaceId);
  assert.equal((await service.resourceRecord(a.record.fileId)).status, 'ready');
});

// ── earlier versions of a file ─────────────────────────────────────────

test('what a file held before each save can be listed and put back; the content it replaces is kept in turn', async () => {
  const { service, workspace, open, at } = await withArchive();
  const a = await open('notes/a.md');
  const second = await service.saveText(a.record.fileId, a.revision, 'SECOND_TEXT_D5\n', 'op-1');
  const third = await service.saveText(a.record.fileId, second.revision, 'THIRD_TEXT_F7\n', 'op-2');

  const versions = await service.listVersions(a.record.fileId);
  for (const version of versions) await valid('FileVersion', version);
  assert.deepEqual(versions.map((v) => v.revision).sort(), [sha('FIRST_TEXT_B3\n'), sha('SECOND_TEXT_D5\n')].sort());
  assert.deepEqual(versions.map((v) => v.size).sort(), ['FIRST_TEXT_B3\n'.length, 'SECOND_TEXT_D5\n'.length].sort());

  // a version is put back only over the content the person was looking at
  assert.deepEqual(await service.restoreVersion(a.record.fileId, sha('FIRST_TEXT_B3\n'), second.revision, 'op-stale'), { status: 'conflict', currentRevision: third.revision });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'THIRD_TEXT_F7\n');

  assert.deepEqual(await service.restoreVersion(a.record.fileId, sha('FIRST_TEXT_B3\n'), third.revision, 'op-3'), { status: 'saved', revision: sha('FIRST_TEXT_B3\n'), sourceRevision: null });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.ok((await service.listVersions(a.record.fileId)).some((v) => v.revision === third.revision), 'what was replaced is itself kept');
  assert.equal((await service.restoreVersion(a.record.fileId, sha('NEVER_KEPT\n'), sha('FIRST_TEXT_B3\n'), 'op-4')).status, 'error');
  assert.deepEqual(await service.listVersions((await open('papers/keep.md')).record.fileId), []);
  assert.equal(workspace.readOnly, false);
});

test('a folder whose records a newer version wrote is not rearranged: no folder is moved, copied, trashed, and nothing is put back', async () => {
  const { service, start, workspace, open, at, project, notes, archive } = await withArchive();
  const a = await open('notes/a.md');
  await service.trashFile((await open('papers/keep.md')).record.fileId, 'op-trash');
  const [item] = await service.listRecovery(workspace.workspaceId);
  const registryFile = path.join(project, '.thoughtdag', 'resources.json');
  const newer = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  newer.schemaVersion = '1.2';
  fs.writeFileSync(registryFile, JSON.stringify(newer, null, 2) + '\n');
  const older = start();
  await assert.rejects(older.moveFolder(workspace.workspaceId, notes, archive, 'notes', 'op-1'), { code: 'read-only' });
  await assert.rejects(older.copyFolder(workspace.workspaceId, notes, archive, 'copy', 'op-2'), { code: 'read-only' });
  await assert.rejects(older.trashFolder(workspace.workspaceId, notes, 'op-3'), { code: 'read-only' });
  await assert.rejects(older.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-4'), { code: 'read-only' });
  assert.equal((await older.restoreVersion(a.record.fileId, a.revision, a.revision, 'op-5')).status, 'readonly');
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['a.md', 'unregistered.txt']);
  assert.deepEqual(fs.readdirSync(at('archive')), []);
  assert.equal(fs.existsSync(at('papers/keep.md')), false);
});
