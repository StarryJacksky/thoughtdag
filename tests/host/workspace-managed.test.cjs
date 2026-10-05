'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceService } = require('../../runtime/workspace/index.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

// The two things only the shell may do with a real path: open a folder it
// chose itself as a workspace (a canvas's own folder), and say where a
// registered file is so the system file manager can show it. Neither takes
// a path from the page, and neither hands one back to it.

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-managed-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

let serial = 0;
function setup() {
  const id = ++serial;
  const stateDir = path.join(base, `state-${id}`);
  const managed = path.join(base, `managed-${id}`, 'workspaces', 'canvas-1');
  const service = createWorkspaceService({ stateDir, pickDirectory: async () => { throw new Error('no picker is expected here'); } });
  return { service, managed, stateDir };
}
const entry = (entries, name) => entries.find((e) => e.name === name);

test('a folder the shell chose opens as a workspace without a picker, and is made if it is not there', async () => {
  const { service, managed } = setup();
  assert.equal(fs.existsSync(managed), false);
  const workspace = await service.openManaged(managed);
  const { validateDTO } = await loadContracts();
  assert.ok(validateDTO('WorkspaceRecord', workspace).ok);
  assert.equal(workspace.kind, 'local');
  assert.equal(workspace.displayName, 'canvas-1');
  assert.equal(workspace.readOnly, false);
  assert.ok(fs.statSync(managed).isDirectory());
  assert.doesNotMatch(JSON.stringify(workspace), /managed-/, 'the record names no path');
});

test('opening the same managed folder again is the same workspace', async () => {
  const { service, managed } = setup();
  const first = await service.openManaged(managed);
  const second = await service.openManaged(managed);
  assert.equal(second.workspaceId, first.workspaceId);
  assert.equal((await service.listWorkspaces()).length, 1);
});

test('a managed folder is an ordinary workspace: files are created and listed in it like in any other', async () => {
  const { service, managed } = setup();
  const workspace = await service.openManaged(managed);
  const made = await service.createFile({ workspaceId: workspace.workspaceId, extension: 'md', origin: 'graph', idempotencyKey: 'op-1' });
  assert.equal(made.relativePath, 'Graph Files/Untitled-001.md');
  assert.ok(fs.existsSync(path.join(managed, 'Graph Files', 'Untitled-001.md')));
  assert.ok(entry(await service.listChildren(workspace.workspaceId), 'Graph Files'));
});

test('a managed folder has to be named by an absolute path', async () => {
  const { service } = setup();
  await assert.rejects(service.openManaged('relative/folder'), { code: 'no-grant' });
  await assert.rejects(service.openManaged(undefined), { code: 'no-grant' });
});

test('where a registered file is can be asked for by its id, and is its real place inside the workspace', async () => {
  const { service, managed } = setup();
  const workspace = await service.openManaged(managed);
  const made = await service.createFile({ workspaceId: workspace.workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: 'op-1' });
  assert.equal(await service.locate(made.fileId), path.join(fs.realpathSync(managed), 'Untitled-001.md'));
});

test('where a file is follows the file when it is moved', async () => {
  const { service, managed } = setup();
  const workspace = await service.openManaged(managed);
  const made = await service.createFile({ workspaceId: workspace.workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: 'op-1' });
  const notes = await service.createFolder(workspace.workspaceId, undefined, 'notes');
  await service.moveFile(made.fileId, notes, 'Untitled-001.md', 'op-2');
  assert.equal(await service.locate(made.fileId), path.join(fs.realpathSync(managed), 'notes', 'Untitled-001.md'));
});

test('a file that is lost, or that no open workspace knows, has no place to show', async () => {
  const { service, managed } = setup();
  const workspace = await service.openManaged(managed);
  const made = await service.createFile({ workspaceId: workspace.workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: 'op-1' });
  fs.rmSync(path.join(managed, 'Untitled-001.md'));
  await service.reconcile(made.fileId);
  await assert.rejects(service.locate(made.fileId), { code: 'lost' });
  await assert.rejects(service.locate('file_nobody_knows'), { code: 'unknown-file' });
});

test('the bytes of a registered file are read by its id, with the revision they hash to', async () => {
  const { service, managed } = setup();
  const workspace = await service.openManaged(managed);
  fs.writeFileSync(path.join(managed, 'data.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const record = await service.registerEntry(workspace.workspaceId, entry(await service.listChildren(workspace.workspaceId), 'data.bin').entryId);
  const read = await service.readBytes(record.fileId);
  assert.deepEqual([...read.bytes], [0xff, 0xfe, 0x00, 0x80]);
  assert.match(read.revision, /^sha256:[0-9a-f]{64}$/);
});
