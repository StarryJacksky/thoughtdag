// Recovery drafts through the workspace service, on real temp folders: text
// typed into a file and not yet written to it is kept in the workspace's own
// records, comes back after a restart, never touches the file itself, and is
// out of reach of everything that reads files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const setup = fixture(test, 'drafts');
const draftsDir = (project) => path.join(project, '.thoughtdag', 'drafts');

test('a draft is kept whole, comes back after a restart, and leaves the file as it is', async () => {
  const { service, start, open, at, project } = await setup();
  const a = await open('notes/a.md');
  const kept = await service.putDraft(a.record.fileId, { text: 'TYPED_NOT_SAVED_G4\n', baseRevision: a.revision });
  assert.ok((await loadContracts()).validateDTO('DocumentDraft', kept).ok);
  assert.deepEqual([kept.fileId, kept.text, kept.baseRevision], [a.record.fileId, 'TYPED_NOT_SAVED_G4\n', a.revision]);
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.deepEqual(await start().getDraft(a.record.fileId), kept);
  assert.deepEqual(fs.readdirSync(draftsDir(project)), [`${a.record.fileId}.json`]);
});

test('a file has one draft: a new one replaces the old, and clearing it leaves none', async () => {
  const { service, open, project } = await setup();
  const a = await open('notes/a.md');
  await service.putDraft(a.record.fileId, { text: 'first try\n', baseRevision: a.revision });
  await service.putDraft(a.record.fileId, { text: 'second try\n', baseRevision: a.revision });
  assert.equal((await service.getDraft(a.record.fileId)).text, 'second try\n');
  assert.equal(await service.clearDraft(a.record.fileId), true);
  assert.equal(await service.getDraft(a.record.fileId), null);
  assert.deepEqual(fs.readdirSync(draftsDir(project)), []);
  assert.equal(await service.clearDraft(a.record.fileId), true, 'clearing what is not there is not an error');
});

test('a draft follows its file through a move and a rename of its folder, because it is kept by the file\'s identity', async () => {
  const { service, workspace, open, notes } = await setup();
  const a = await open('notes/a.md');
  await service.putDraft(a.record.fileId, { text: 'TYPED_NOT_SAVED_G4\n', baseRevision: a.revision });
  await service.moveFile(a.record.fileId, undefined, 'renamed.md', 'op-1');
  await service.moveFolder(workspace.workspaceId, notes, undefined, 'reading', 'op-2');
  assert.equal((await service.getDraft(a.record.fileId)).text, 'TYPED_NOT_SAVED_G4\n');
});

test('drafts are not files of the workspace: no listing shows them and nothing reads them as one', async () => {
  const { service, workspace, open } = await setup();
  const a = await open('notes/a.md');
  await service.putDraft(a.record.fileId, { text: 'x', baseRevision: a.revision });
  assert.deepEqual((await service.listChildren(workspace.workspaceId)).map((e) => e.name), ['notes', 'papers']);
  await assert.rejects(service.listChildren(workspace.workspaceId, entryIdOf('.thoughtdag/drafts')), { code: 'metadata-directory' });
  await assert.rejects(service.registerEntry(workspace.workspaceId, entryIdOf(`.thoughtdag/drafts/${a.record.fileId}.json`)), { code: 'metadata-directory' });
});

test('a draft that is not text, is too large, names no base or an unknown file is refused, and nothing is kept', async () => {
  const { service, open, project } = await setup();
  const a = await open('notes/a.md');
  await assert.rejects(service.putDraft(a.record.fileId, { text: 42, baseRevision: a.revision }), { code: 'invalid-request' });
  await assert.rejects(service.putDraft(a.record.fileId, { text: 'x', baseRevision: 'latest' }), { code: 'invalid-request' });
  await assert.rejects(service.putDraft(a.record.fileId, { text: 'x'.repeat(8 * 1024 * 1024 + 1), baseRevision: a.revision }), { code: 'too-large' });
  await assert.rejects(service.putDraft('file_nobody_knows', { text: 'x', baseRevision: sha('x') }), { code: 'unknown-file' });
  assert.equal(fs.existsSync(draftsDir(project)) ? fs.readdirSync(draftsDir(project)).length : 0, 0);
});

test('a draft cut short while it was being written does not replace the one that was there', async () => {
  let fail = false;
  const io = { ...fs.promises, rename: async (from, to) => { if (fail && String(from).includes('.tdag-draft-')) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.promises.rename(from, to); } };
  const { service, open, project } = await setup({ io });
  const a = await open('notes/a.md');
  await service.putDraft(a.record.fileId, { text: 'kept before\n', baseRevision: a.revision });
  fail = true;
  await assert.rejects(service.putDraft(a.record.fileId, { text: 'never landed\n', baseRevision: a.revision }));
  assert.equal((await service.getDraft(a.record.fileId)).text, 'kept before\n');
  assert.deepEqual(fs.readdirSync(draftsDir(project)), [`${a.record.fileId}.json`]);
});

test('a folder that is read-only keeps no drafts', { skip: process.platform === 'win32' || process.getuid() === 0 }, async () => {
  const { start, project, workspace, open } = await setup();
  const a = await open('notes/a.md');
  fs.chmodSync(project, 0o555);
  const readOnly = start({ stateDir: path.join(path.dirname(project), 'state-readonly-drafts') });
  const again = await readOnly.chooseRoot();
  assert.equal(again.workspaceId, workspace.workspaceId);
  assert.equal(again.readOnly, true);
  await assert.rejects(readOnly.putDraft(a.record.fileId, { text: 'x', baseRevision: a.revision }), { code: 'read-only' });
  fs.chmodSync(project, 0o755);
});
