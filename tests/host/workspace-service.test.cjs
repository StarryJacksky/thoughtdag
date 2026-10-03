// The workspace service on real temp folders: how a folder is opened, what
// listing and registering do and do not touch, and who may call the door.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceService, entryIdOf } = require('../../runtime/workspace/index.cjs');
const { checkSender, senderOf } = require('../../runtime/workspace/ipc-guard.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const posix = process.platform !== 'win32';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-workspace-')));
test.after(() => {
  // folders made read-only by a test must be writable again to be removed
  for (const dir of fs.readdirSync(base)) { try { fs.chmodSync(path.join(base, dir), 0o755); } catch { /* not a directory */ } }
  fs.rmSync(base, { recursive: true, force: true });
});

let serial = 0;
/** A fresh project folder, a fresh shell state directory, and a service over them. */
function setup({ files = { 'notes/a.md': 'INSIDE_NOTE_F2', 'papers/p.md': 'PAPER_NOTE_G3', 'readme.md': 'TOP_NOTE_J6' } } = {}) {
  const id = ++serial;
  const project = path.join(base, `project-${id}`);
  const stateDir = path.join(base, `state-${id}`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  }
  fs.mkdirSync(project, { recursive: true });
  let pick = project;
  const service = (dir = stateDir) => createWorkspaceService({ stateDir: dir, pickDirectory: async () => pick });
  return { project, stateDir, service, choose: (p) => { pick = p; } };
}

async function assertValid(kind, value) {
  const { validateDTO } = await loadContracts();
  const result = validateDTO(kind, value);
  assert.ok(result.ok, `${kind}: ${JSON.stringify(result.errors)}`);
}
const entry = (entries, name) => entries.find((e) => e.name === name);

test('choosing a folder opens it as a local workspace and gives the folder an id of its own', async () => {
  const { project, service } = setup();
  const record = await service().chooseRoot();
  await assertValid('WorkspaceRecord', record);
  assert.equal(record.kind, 'local');
  assert.equal(record.displayName, path.basename(project));
  assert.equal(record.readOnly, false);
  const identity = JSON.parse(fs.readFileSync(path.join(project, '.thoughtdag', 'workspace.json'), 'utf8'));
  assert.equal(identity.workspaceId, record.workspaceId);
  assert.equal(identity.schemaVersion, '1.1');
  // the record names no path
  assert.ok(!JSON.stringify(record).includes(base));
});

test('cancelling the picker opens nothing', async () => {
  const { service, choose, stateDir } = setup();
  choose(null);
  assert.equal(await service().chooseRoot(), null);
  assert.equal(fs.existsSync(stateDir), false);
});

test('a file, or a whole disk, is not a workspace', async () => {
  const { project, service, choose } = setup();
  choose(path.join(project, 'readme.md'));
  await assert.rejects(service().chooseRoot(), (e) => e.code === 'not-a-directory');
  choose(path.parse(project).root);
  await assert.rejects(service().chooseRoot(), (e) => e.code === 'root-too-wide');
});

test('choosing the same folder again returns the same workspace', async () => {
  const { service } = setup();
  const s = service();
  const first = await s.chooseRoot();
  assert.deepEqual(await s.chooseRoot(), first);
  assert.equal((await s.listWorkspaces()).length, 1);
});

test('an open workspace is still open after a restart, and its folder is the same workspace on another profile', async () => {
  const { service, stateDir } = setup();
  const record = await service().chooseRoot();
  assert.deepEqual(await service().listWorkspaces(), [record]);
  // another profile: its own grants, the same folder
  const elsewhere = await service(stateDir + '-other').chooseRoot();
  assert.equal(elsewhere.workspaceId, record.workspaceId);
  assert.notEqual(elsewhere.rootGrantId, record.rootGrantId);
});

test('opening and listing read no file content', { skip: !posix }, async () => {
  const { project, service } = setup();
  fs.chmodSync(path.join(project, 'notes', 'a.md'), 0o000);
  const s = service();
  const record = await s.chooseRoot();
  const top = await s.listChildren(record.workspaceId);
  const notes = await s.listChildren(record.workspaceId, entry(top, 'notes').entryId);
  assert.deepEqual(notes.map((e) => e.name), ['a.md']);
  fs.chmodSync(path.join(project, 'notes', 'a.md'), 0o644);
});

test('a listing shows folders first, hides the workspace\'s own records, and names no path', async () => {
  const { service } = setup();
  const s = service();
  const record = await s.chooseRoot();
  const top = await s.listChildren(record.workspaceId);
  for (const e of top) await assertValid('FileEntry', e);
  assert.deepEqual(top.map((e) => [e.name, e.kind]), [['notes', 'folder'], ['papers', 'folder'], ['readme.md', 'file']]);
  assert.ok(top.every((e) => e.parentId === null && e.fileId === undefined));
  assert.ok(!JSON.stringify(top).includes(base));
  const notes = await s.listChildren(record.workspaceId, entry(top, 'notes').entryId);
  assert.equal(notes[0].parentId, entry(top, 'notes').entryId);
});

test('a link that leads outside is listed as unknown and cannot be entered', { skip: !posix }, async () => {
  const { project, service } = setup();
  const outside = path.join(base, 'outside-target');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET_H4');
  fs.symlinkSync(outside, path.join(project, 'out-link'));
  const s = service();
  const record = await s.chooseRoot();
  const link = entry(await s.listChildren(record.workspaceId), 'out-link');
  assert.equal(link.kind, 'unknown');
  await assert.rejects(s.listChildren(record.workspaceId, link.entryId), (e) => e.code === 'escapes-root');
  await assert.rejects(s.registerEntry(record.workspaceId, entryIdOf('out-link/secret.txt')), (e) => e.code === 'escapes-root');
});

test('a file gets its identity when first used, keeps it, and shows it in later listings', async () => {
  const { project, service } = setup();
  const s = service();
  const record = await s.chooseRoot();
  const readme = entry(await s.listChildren(record.workspaceId), 'readme.md');
  const resource = await s.registerEntry(record.workspaceId, readme.entryId);
  await assertValid('ResourceRecord', resource);
  assert.deepEqual({ ...resource, fileId: null }, {
    fileId: null, workspaceId: record.workspaceId, relativePath: 'readme.md',
    locator: { kind: 'local', rootGrantId: record.rootGrantId, relativePath: 'readme.md' },
    sourceRevision: null, mediaType: 'text/markdown', origin: 'workspace', status: 'ready',
    revision: null, // the content has not been read
  });
  assert.equal((await s.registerEntry(record.workspaceId, readme.entryId)).fileId, resource.fileId);
  assert.equal(entry(await s.listChildren(record.workspaceId), 'readme.md').fileId, resource.fileId);
  // and after a restart
  assert.equal((await service().registerEntry(record.workspaceId, readme.entryId)).fileId, resource.fileId);
  const stored = JSON.parse(fs.readFileSync(path.join(project, '.thoughtdag', 'resources.json'), 'utf8'));
  assert.equal(stored.schemaVersion, '1.1');
  assert.deepEqual(stored.resources.map((r) => r.record.fileId), [resource.fileId]);
});

test('two files of one name in two folders are two resources', async () => {
  const { service } = setup({ files: { 'papers/notes.md': 'DIR_A_NOTES_R4', 'drafts/notes.md': 'DIR_B_NOTES_T8' } });
  const s = service();
  const record = await s.chooseRoot();
  const a = await s.registerEntry(record.workspaceId, entryIdOf('papers/notes.md'));
  const b = await s.registerEntry(record.workspaceId, entryIdOf('drafts/notes.md'));
  assert.notEqual(a.fileId, b.fileId);
});

test('an entry id the service did not make is refused', async () => {
  const { service } = setup();
  const s = service();
  const record = await s.chooseRoot();
  for (const forged of ['notes/a.md', 'e_', 'e_!!!', entryIdOf('../outside/secret.txt'), entryIdOf('/etc/passwd'), entryIdOf('.thoughtdag/workspace.json'), 42, null]) {
    await assert.rejects(s.registerEntry(record.workspaceId, forged), (e) => ['invalid-entry', 'traversal', 'absolute-path', 'metadata-directory', 'not-a-file'].includes(e.code), JSON.stringify(forged));
  }
  await assert.rejects(s.listChildren(record.workspaceId, entryIdOf('..')), (e) => e.code === 'traversal');
});

test('a workspace that is not open is refused', async () => {
  const { service } = setup();
  const s = service();
  await assert.rejects(s.listChildren('ws_not_open'), (e) => e.code === 'no-grant');
  await assert.rejects(s.registerResource('grant_not_given', 'readme.md'), (e) => e.code === 'no-grant');
});

test('a folder that cannot be written opens read-only and nothing is written into it', { skip: !posix || process.getuid() === 0 }, async () => {
  const { project, service } = setup();
  fs.chmodSync(project, 0o555);
  const s = service();
  const record = await s.chooseRoot();
  assert.equal(record.readOnly, true);
  const resource = await s.registerEntry(record.workspaceId, entryIdOf('readme.md'));
  assert.equal(resource.status, 'readonly');
  assert.equal(fs.existsSync(path.join(project, '.thoughtdag')), false);
});

test('a registry written by a newer version is read and never rewritten', async () => {
  const { project, service } = setup();
  const s = service();
  const record = await s.chooseRoot();
  const file = path.join(project, '.thoughtdag', 'resources.json');
  const newer = JSON.stringify({ schemaVersion: '1.2', workspaceId: record.workspaceId, resources: [], futureField: { kept: true } });
  fs.writeFileSync(file, newer);
  const resource = await s.registerEntry(record.workspaceId, entryIdOf('readme.md'));
  assert.equal(resource.status, 'readonly');
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
});

test('a registry that is damaged is reported and left exactly as it was', async () => {
  const { project, service } = setup();
  const s = service();
  const record = await s.chooseRoot();
  const file = path.join(project, '.thoughtdag', 'resources.json');
  fs.writeFileSync(file, '{ "schemaVersion": "1.1", "resources": [ TRUNCATED');
  await assert.rejects(s.registerEntry(record.workspaceId, entryIdOf('readme.md')), (e) => e.code === 'corrupt');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "schemaVersion": "1.1", "resources": [ TRUNCATED');
});

test('closing a workspace forgets the grant and touches nothing in the folder', async () => {
  const { project, service } = setup();
  const s = service();
  const record = await s.chooseRoot();
  await s.registerEntry(record.workspaceId, entryIdOf('readme.md'));
  const before = fs.readdirSync(project, { recursive: true }).sort();
  assert.equal(await s.closeWorkspace(record.workspaceId), true);
  assert.deepEqual(await s.listWorkspaces(), []);
  assert.deepEqual(fs.readdirSync(project, { recursive: true }).sort(), before);
  await assert.rejects(s.listChildren(record.workspaceId), (e) => e.code === 'no-grant');
});

// ── who may call the door ──────────────────────────────────────────────

const app = { origin: 'http://127.0.0.1:31173', webContentsId: 1 };

test('a call from the top frame of the app window, showing the app, is accepted', () => {
  assert.deepEqual(checkSender({ url: 'http://127.0.0.1:31173/?dv=0.5.16', isMainFrame: true, webContentsId: 1 }, app), { trusted: true });
});

for (const [why, sender] of [
  ['a frame inside the page', { url: 'http://127.0.0.1:31173/', isMainFrame: false, webContentsId: 1 }],
  ['another window', { url: 'http://127.0.0.1:31173/', isMainFrame: true, webContentsId: 2 }],
  ['the app window showing another site', { url: 'https://example.com/', isMainFrame: true, webContentsId: 1 }],
  ['the same host on another port', { url: 'http://127.0.0.1:9999/', isMainFrame: true, webContentsId: 1 }],
  ['a data: page', { url: 'data:text/html,<script>1</script>', isMainFrame: true, webContentsId: 1 }],
  ['a local file page', { url: 'file:///synthetic/evil.html', isMainFrame: true, webContentsId: 1 }],
  ['no sender at all', null],
]) {
  test(`a call from ${why} is refused`, () => {
    assert.equal(checkSender(sender, app).trusted, false);
  });
}

test('nothing is accepted before the app has an origin', () => {
  assert.equal(checkSender({ url: 'http://127.0.0.1:31173/', isMainFrame: true, webContentsId: 1 }, { origin: '', webContentsId: 1 }).trusted, false);
  assert.equal(checkSender({ url: 'http://127.0.0.1:31173/', isMainFrame: true, webContentsId: 1 }, null).trusted, false);
});

test('an IPC event is read as its frame: the top frame has no parent', () => {
  assert.deepEqual(senderOf({ sender: { id: 1 }, senderFrame: { url: 'http://127.0.0.1:31173/', parent: null } }), { url: 'http://127.0.0.1:31173/', isMainFrame: true, webContentsId: 1 });
  assert.equal(senderOf({ sender: { id: 1 }, senderFrame: { url: 'http://127.0.0.1:31173/frame', parent: {} } }).isMainFrame, false);
  // a frame that was destroyed before the call was handled
  assert.equal(senderOf({ sender: { id: 1 }, senderFrame: null }).isMainFrame, false);
});
