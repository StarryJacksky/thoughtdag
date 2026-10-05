// The page's door into workspaces, driven without a window: every call the
// page can make, answered through the provider registry. A local folder on
// a real temp directory, and beside it a stand-in for a source that is not
// a folder at all, registered the way a real one would be. What is checked
// is that the door reaches each source only through its provider, asks what
// the source supports before asking it to do anything, and never sends a
// call meant for one source to the other.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, sha, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { createProviderRegistry } = require('../../runtime/workspace/providers/provider-registry.cjs');
const { createWorkspaceDoor, watchingThrough, MAX_PAGE_READ_BYTES } = require('../../runtime/workspace/door.cjs');
const { createSubscriptionHub } = require('../../runtime/workspace/subscriptions.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const setup = fixture(test, 'door');
const context = { senderId: 7 };
const spaceScope = { workspaceId: 'ws_space', displayName: 'Lab space', readOnly: false, kind: 'chatgpt-space', connectionRef: 'conn_1', accountScope: 'acct_1', spaceId: 'space_1', rootObjectId: 'obj_root' };
const ALL = { list: 'supported', read: 'supported', create: 'supported', update: 'supported', move: 'unsupported', trash: 'unsupported', conditionalWrite: 'supported', pagePatch: 'unsupported', changes: 'unsupported', uploadCustomType: 'unknown' };

/** A source that is not a folder: pages kept in memory, every call recorded. */
function standInSource(capabilities = ALL) {
  const calls = [];
  const pages = new Map([['obj_notes', { text: 'REMOTE_PAGE_N1\n', revision: 'rev-1' }]]);
  const note = (name, ...args) => { calls.push([name, ...args]); };
  const provider = {
    capabilities: async (scope) => { note('capabilities', scope.workspaceId); return capabilities; },
    list: async (scope, parentId, cursor) => {
      note('list', parentId ?? null, cursor ?? null);
      const entry = (id, name) => ({ entryId: id, parentId: null, name, kind: 'page', fileId: id });
      return cursor === undefined
        ? { entries: [entry('obj_notes', 'Notes')], nextCursor: 'page-2', completeness: 'complete' }
        : { entries: [entry('obj_plan', 'Plan')], nextCursor: null, completeness: provider.partial ? 'partial' : 'complete' };
    },
    read: async (scope, fileId, options) => {
      note('read', fileId, options);
      const page = pages.get(fileId);
      return { fileId, sourceRevision: page.revision, contentHash: sha(page.text), representation: 'text', payload: page.text, fidelity: provider.derived ? 'derived' : 'original' };
    },
    write: async (scope, request) => {
      note('write', request);
      const page = pages.get(request.fileId);
      if (page.revision !== request.baseSourceRevision) return { status: 'conflict', currentRevision: page.revision };
      pages.set(request.fileId, { text: request.payload, revision: 'rev-2' });
      return { status: 'saved', sourceRevision: 'rev-2', contentHash: sha(request.payload) };
    },
    create: async (scope, request) => {
      note('create', request);
      return { fileId: 'obj_new', workspaceId: scope.workspaceId, locator: { kind: 'chatgpt-space', connectionRef: scope.connectionRef, accountScope: scope.accountScope, spaceId: scope.spaceId, objectId: 'obj_new', objectKind: 'page' }, sourceRevision: 'rev-1', mediaType: 'text/markdown', origin: 'workspace', status: 'ready', revision: null };
    },
  };
  const remote = { workspaces: async () => [spaceScope], workspaceOfFile: async (fileId) => (pages.has(fileId) || fileId === 'obj_new' ? spaceScope : null) };
  return { provider, remote, calls, pages };
}

async function doorOver(options = {}, standIn = standInSource()) {
  const made = await setup(options);
  // the local service with every call to it counted, to show what never reaches the disk
  const localCalls = [];
  const service = new Proxy(made.service, { get: (target, key) => (typeof target[key] === 'function' ? (...args) => { localCalls.push(String(key)); return target[key](...args); } : target[key]) });
  const providers = createProviderRegistry({ service, providers: { 'chatgpt-space': standIn.provider }, remote: standIn.remote });
  const shown = [];
  const hub = createSubscriptionHub({ service: watchingThrough(providers), send: () => {} });
  const door = createWorkspaceDoor({ service, providers, canvasFolder: async (canvasId) => `${made.base}/canvases/${canvasId}`, showInFileManager: (p) => shown.push(p), hub });
  const ask = (channel, ...args) => door[`workspace:${channel}`](context, ...args);
  return { ...made, door, ask, standIn, localCalls, shown, hub };
}

// ── a local folder, through the door ───────────────────────────────────

test('a local folder answers every call of the door as it did before the door was put behind providers', async () => {
  const { ask, workspace, at, request, notes, shown } = await doorOver();
  const { validateDTO } = await loadContracts();
  assert.deepEqual((await ask('list-workspaces')).map((w) => w.workspaceId), [workspace.workspaceId, 'ws_space']);
  assert.deepEqual((await ask('list-children', workspace.workspaceId)).map((e) => e.name), ['notes', 'papers']);
  assert.ok(validateDTO('SourceCapabilities', await ask('capabilities', workspace.workspaceId)).ok);

  const a = await ask('register-entry', workspace.workspaceId, entryIdOf('notes/a.md'));
  const read = await ask('read-text', a.fileId);
  assert.deepEqual(read, { text: 'FIRST_TEXT_B3\n', revision: sha('FIRST_TEXT_B3\n'), encoding: 'utf-8', newline: 'lf' });
  assert.ok(validateDTO('TextRevision', read).ok);
  assert.deepEqual(await ask('save-text', a.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-save'), { status: 'saved', revision: sha('SECOND_TEXT_D5\n'), sourceRevision: null });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
  assert.equal((await ask('save-text', a.fileId, read.revision, 'STALE\n', 'op-stale')).status, 'conflict');

  const source = await ask('read-source', a.fileId);
  assert.ok(validateDTO('SourceRead', source).ok);
  assert.deepEqual([source.representation, source.payload, source.contentHash], ['text', 'SECOND_TEXT_D5\n', sha('SECOND_TEXT_D5\n')]);

  const made = await ask('create-file', request('op-create', { parentId: notes }));
  assert.equal(made.relativePath, 'notes/Untitled-001.md');
  const copied = await ask('import-text', request('op-import'), { text: 'COPIED_H9\n', name: 'page', provenance: { source: 'other' } });
  assert.equal(copied.origin, 'import');
  const folder = await ask('create-folder', workspace.workspaceId, null, 'drafts');
  assert.equal((await ask('move-file', made.fileId, folder, 'draft.md', 'op-move')).relativePath, 'drafts/draft.md');
  assert.equal((await ask('copy-file', a.fileId, folder, 'a-copy.md', 'op-copy')).relativePath, 'drafts/a-copy.md');
  assert.equal((await ask('reveal', a.fileId)), true);
  assert.deepEqual(shown, [at('notes/a.md')]);
  assert.equal((await ask('trash-file', made.fileId, 'op-trash')).fileId, made.fileId);
  assert.equal((await ask('reconcile', made.fileId)).status, 'missing');
  assert.deepEqual(await ask('rescan', workspace.workspaceId), []);

  // folders, the recovery area and earlier versions, through the same door
  assert.equal(await ask('move-folder', workspace.workspaceId, folder, null, 'outlines', 'op-move-folder'), entryIdOf('outlines'));
  assert.equal(await ask('copy-folder', workspace.workspaceId, entryIdOf('outlines'), null, 'outlines-2', 'op-copy-folder'), entryIdOf('outlines-2'));
  assert.equal(fs.readFileSync(at('outlines-2/a-copy.md'), 'utf8'), 'SECOND_TEXT_D5\n');
  const kept = await ask('list-recovery', workspace.workspaceId);
  assert.deepEqual(kept.map((item) => [item.kind, item.name, item.relativePath]), [['file', 'draft.md', 'drafts/draft.md']]);
  assert.ok(kept.every((item) => validateDTO('RecoveryItem', item).ok));
  const gone = await ask('trash-folder', workspace.workspaceId, entryIdOf('outlines-2'), 'op-trash-folder');
  assert.equal(gone.kind, 'folder');
  assert.equal(await ask('restore', workspace.workspaceId, gone.receiptId, 'op-restore'), entryIdOf('outlines-2'));
  assert.ok(fs.existsSync(at('outlines-2/a-copy.md')));
  const versions = await ask('list-versions', a.fileId);
  assert.deepEqual(versions.map((v) => v.revision), [sha('FIRST_TEXT_B3\n')]);
  assert.equal((await ask('restore-version', a.fileId, versions[0].revision, sha('SECOND_TEXT_D5\n'), 'op-version')).status, 'saved');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
});

test('a file too large to send to the page is refused from its size, and none of it is read', async () => {
  let reads = 0;
  const counting = { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return new Proxy(handle, { get: (target, key) => (key === 'readFile' ? async (...a) => { reads++; return target.readFile(...a); } : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
  } };
  const { ask, workspace, at } = await doorOver({ io: counting });
  fs.writeFileSync(at('notes/huge.bin'), Buffer.alloc(MAX_PAGE_READ_BYTES + 1));
  const huge = await ask('register-entry', workspace.workspaceId, entryIdOf('notes/huge.bin'));
  reads = 0;
  await assert.rejects(ask('read-source', huge.fileId), { code: 'too-large' });
  await assert.rejects(ask('read-text', huge.fileId), { code: 'too-large' });
  assert.equal(reads, 0);
});

test('a canvas\'s own folder is opened where the shell says it is, and the page names only the canvas', async () => {
  const { ask, base } = await doorOver();
  const own = await ask('open-default', 'canvas-9');
  assert.equal(own.displayName, 'canvas-9');
  assert.ok(fs.statSync(`${base}/canvases/canvas-9`).isDirectory());
  assert.doesNotMatch(JSON.stringify(own), /canvases/);
});

// ── a source that is not a folder, through the same door ───────────────

test('a source that is not a folder is listed, read and written through its provider alone; the local service is never asked about its content', async () => {
  const { ask, standIn, localCalls } = await doorOver();
  localCalls.length = 0;
  // the listing is read to its end, across the source's own pages
  assert.deepEqual((await ask('list-children', 'ws_space')).map((e) => e.name), ['Notes', 'Plan']);
  assert.deepEqual(standIn.calls.filter(([name]) => name === 'list'), [['list', null, null], ['list', null, 'page-2']]);

  // the revision a save must name is the source's own version, not a hash of the content
  const read = await ask('read-text', 'obj_notes');
  assert.deepEqual(read, { text: 'REMOTE_PAGE_N1\n', revision: 'rev-1', encoding: 'utf-8', newline: 'lf' });
  assert.deepEqual(await ask('save-text', 'obj_notes', read.revision, 'EDITED_PAGE_N2\n', 'op-1'), { status: 'saved', revision: 'rev-2', sourceRevision: 'rev-2' });
  assert.equal(standIn.pages.get('obj_notes').text, 'EDITED_PAGE_N2\n');
  assert.deepEqual(await ask('save-text', 'obj_notes', 'rev-1', 'STALE\n', 'op-2'), { status: 'conflict', currentRevision: 'rev-2' });
  assert.equal((await ask('create-file', { workspaceId: 'ws_space', extension: 'md', origin: 'workspace', idempotencyKey: 'op-3' })).fileId, 'obj_new');

  // what the local service was asked: which workspace an id is, never anything about the content
  assert.deepEqual([...new Set(localCalls)].sort(), ['resourceRecord', 'workspaceRecord']);
});

test('what a source does not say it supports is refused at the door and never attempted', async () => {
  const cannot = { ...ALL, update: 'unknown', create: 'unsupported' };
  const { ask, standIn } = await doorOver({}, standInSource(cannot));
  assert.deepEqual(await ask('save-text', 'obj_notes', 'rev-1', 'MUST_NOT_LAND\n', 'op-1'), { status: 'readonly', reason: 'this source does not support updating (unknown)' });
  await assert.rejects(ask('create-file', { workspaceId: 'ws_space', extension: 'md', origin: 'workspace', idempotencyKey: 'op-2' }), { code: 'unsupported' });
  await assert.rejects(ask('import-text', { workspaceId: 'ws_space', extension: 'md', origin: 'workspace', idempotencyKey: 'op-3' }, { text: 'x', provenance: { source: 'other' } }), { code: 'unsupported' });
  await assert.rejects(ask('move-file', 'obj_notes', null, 'renamed', 'op-4'), { code: 'unsupported' });
  await assert.rejects(ask('trash-file', 'obj_notes', 'op-5'), { code: 'unsupported' });
  await assert.rejects(ask('move-folder', 'ws_space', 'obj_folder', null, 'renamed', 'op-6'), { code: 'unsupported' });
  await assert.rejects(ask('trash-folder', 'ws_space', 'obj_folder', 'op-7'), { code: 'unsupported' });
  await assert.rejects(ask('copy-folder', 'ws_space', 'obj_folder', null, 'copy', 'op-8'), { code: 'unsupported' });
  await assert.rejects(ask('restore', 'ws_space', 'trash_1', 'op-9'), { code: 'unsupported' });
  await assert.rejects(ask('subscribe', 'ws_space'), { code: 'unsupported' });
  assert.deepEqual(standIn.calls.filter(([name]) => ['write', 'create'].includes(name)), []);
  assert.equal(standIn.pages.get('obj_notes').text, 'REMOTE_PAGE_N1\n');
});

test('a source that supports an operation in name but has no way to do it is refused, not sent to the disk', async () => {
  const claims = { ...ALL, move: 'supported', trash: 'supported' };
  const { ask, localCalls } = await doorOver({}, standInSource(claims));
  localCalls.length = 0;
  await assert.rejects(ask('move-file', 'obj_notes', null, 'renamed', 'op-1'), { code: 'unsupported' });
  await assert.rejects(ask('trash-file', 'obj_notes', 'op-2'), { code: 'unsupported' });
  await assert.rejects(ask('reveal', 'obj_notes'), { code: 'unsupported' });
  assert.ok(!localCalls.some((name) => ['moveFile', 'trashFile', 'locate'].includes(name)));
});

test('part of a listing is not shown as the listing: the door says it could not be listed whole', async () => {
  const standIn = standInSource();
  standIn.provider.partial = true;
  const { ask } = await doorOver({}, standIn);
  await assert.rejects(ask('list-children', 'ws_space'), { code: 'partial-listing' });
});

test('a rendering of a file is not opened for editing as if it were the file', async () => {
  const standIn = standInSource();
  standIn.provider.derived = true;
  const { ask } = await doorOver({}, standIn);
  await assert.rejects(ask('read-text', 'obj_notes'), { code: 'not-text' });
  assert.equal((await ask('read-source', 'obj_notes')).fidelity, 'derived');
});

test('an id that belongs to no open workspace is refused, whichever source might have had it', async () => {
  const { ask } = await doorOver();
  await assert.rejects(ask('read-text', 'file_nobody_knows'), { code: 'unknown-file' });
  await assert.rejects(ask('list-children', 'ws_nobody_knows'), { code: 'no-grant' });
});

test('subscribing through the door is listening through the workspace\'s provider, for the page that asked', async () => {
  const { ask, workspace, hub } = await doorOver();
  assert.equal(await ask('subscribe', workspace.workspaceId), true);
  assert.deepEqual(hub.active(), [workspace.workspaceId]);
  hub.releaseOwner(context.senderId);
  assert.deepEqual(hub.active(), []);
  assert.equal(await ask('subscribe', workspace.workspaceId), true);
  assert.equal(await ask('unsubscribe', workspace.workspaceId), true);
  assert.deepEqual(hub.active(), []);
});
