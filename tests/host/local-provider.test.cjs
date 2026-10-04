// Workspace sources behind one set of calls: the local folder through its
// provider, the space provider that is blocked, and the helpers every caller
// uses to stay ignorant of which kind of source it is talking to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createWorkspaceService, entryIdOf } = require('../../runtime/workspace/index.cjs');
const { createProviderRegistry } = require('../../runtime/workspace/providers/provider-registry.cjs');
const { createLocalProvider } = require('../../runtime/workspace/providers/local.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const helpers = import('../../shared/workspace/provider-helpers.mjs');
const posix = process.platform !== 'win32';
const unprivileged = posix && process.getuid() !== 0;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-provider-')));
test.after(() => {
  for (const dir of fs.readdirSync(base)) { try { fs.chmodSync(path.join(base, dir), 0o755); } catch { /* not a directory */ } }
  fs.rmSync(base, { recursive: true, force: true });
});

const sha = (content) => 'sha256:' + createHash('sha256').update(content).digest('hex');

let serial = 0;
async function setup(files = { 'notes/a.md': 'FIRST_TEXT_B3\n', 'papers/keep.md': 'KEEP_TEXT_C4\n' }, { readOnly = false } = {}) {
  const id = ++serial;
  const project = path.join(base, `project-${id}`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  }
  if (readOnly) fs.chmodSync(project, 0o555);
  const service = createWorkspaceService({ stateDir: path.join(base, `state-${id}`), pickDirectory: async () => project });
  const scope = await service.chooseRoot();
  const registry = createProviderRegistry({ service });
  return { project, service, scope, registry, provider: registry.providerOf(scope), at: (rel) => path.join(project, rel) };
}

async function assertValid(kind, value) {
  const { validateDTO } = await loadContracts();
  const result = validateDTO(kind, value);
  assert.ok(result.ok, `${kind}: ${JSON.stringify(result.errors)}`);
}
const spaceScope = { workspaceId: 'ws_space', displayName: 'Lab space', readOnly: true, kind: 'chatgpt-space', connectionRef: 'conn_1', accountScope: 'acct_1', spaceId: 'space_1', rootObjectId: 'obj_root' };

// ── the local folder as a source ───────────────────────────────────────

test('a writable local folder supports everything a folder can do, and has no native pages', async () => {
  const { provider, scope } = await setup();
  const capabilities = await provider.capabilities(scope);
  await assertValid('SourceCapabilities', capabilities);
  assert.deepEqual(capabilities, {
    list: 'supported', read: 'supported', create: 'supported', update: 'supported', move: 'supported', trash: 'supported',
    conditionalWrite: 'supported', pagePatch: 'unsupported', changes: 'supported', uploadCustomType: 'supported',
  });
});

test('a read-only local folder supports reading and nothing that changes it', { skip: !unprivileged }, async () => {
  const { provider, scope } = await setup(undefined, { readOnly: true });
  const capabilities = await provider.capabilities(scope);
  assert.deepEqual([capabilities.list, capabilities.read], ['supported', 'supported']);
  for (const operation of ['create', 'update', 'move', 'trash', 'conditionalWrite', 'uploadCustomType']) assert.equal(capabilities[operation], 'unsupported', operation);
});

test('a large folder is listed in pages, and reading the pages to the end gives what the service lists', async () => {
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`data/file-${i}.md`, String(i)]));
  const { service, scope } = await setup(files);
  const provider = createLocalProvider(service, { pageSize: 3 });
  const data = entryIdOf('data');
  const first = await provider.list(scope, data);
  await assertValid('ResourcePage', first);
  assert.deepEqual([first.entries.length, first.nextCursor !== null, first.completeness], [3, true, 'complete']);
  const { collectPages } = await helpers;
  const all = await collectPages(provider, scope, data);
  assert.equal(all.completeness, 'complete');
  assert.deepEqual(all.entries, await service.listChildren(scope.workspaceId, data));
  await assert.rejects(provider.list(scope, data, 'page-2'), (e) => e.code === 'invalid-cursor');
});

test('reading gives text for text and bytes for the rest, each with the hash of its content', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  const { service, scope, provider, at } = await setup();
  fs.writeFileSync(at('notes/figure.png'), png);
  const text = await service.registerEntry(scope.workspaceId, entryIdOf('notes/a.md'));
  const image = await service.registerEntry(scope.workspaceId, entryIdOf('notes/figure.png'));
  const readText = await provider.read(scope, text.fileId);
  await assertValid('SourceRead', readText);
  assert.deepEqual(readText, { fileId: text.fileId, sourceRevision: null, contentHash: sha('FIRST_TEXT_B3\n'), representation: 'text', payload: 'FIRST_TEXT_B3\n', fidelity: 'original' });
  const readImage = await provider.read(scope, image.fileId);
  assert.deepEqual([readImage.representation, readImage.contentHash, Buffer.from(readImage.payload).equals(png)], ['bytes', sha(png), true]);
});

test('writing through the provider is the same conditional save, on the same file identity', async () => {
  const { service, scope, provider, at } = await setup();
  const { writeThrough, writeBaseOf } = await helpers;
  const record = await service.registerEntry(scope.workspaceId, entryIdOf('notes/a.md'));
  const read = await provider.read(scope, record.fileId);
  const request = { fileId: record.fileId, baseSourceRevision: writeBaseOf(read), representation: 'text', payload: 'SECOND_TEXT_D5\n', opId: 'op-1' };
  await assertValid('SourceWrite', request);
  const saved = await writeThrough(provider, scope, request);
  await assertValid('SourceWriteResult', saved);
  assert.deepEqual(saved, { status: 'saved', sourceRevision: null, contentHash: sha('SECOND_TEXT_D5\n') });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
  assert.equal((await service.registerEntry(scope.workspaceId, entryIdOf('notes/a.md'))).fileId, record.fileId);

  // the revision that was read is now stale
  const stale = await writeThrough(provider, scope, { ...request, payload: 'THIRD\n', opId: 'op-2' });
  await assertValid('SourceWriteResult', stale);
  assert.deepEqual(stale, { status: 'conflict', currentRevision: sha('SECOND_TEXT_D5\n') });
  assert.deepEqual(await writeThrough(provider, scope, { ...request, representation: 'bytes', payload: new Uint8Array([1]), opId: 'op-3' }), { status: 'unsupported', reason: 'a local file is written as text' });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
});

test('creating through the provider is the same creation, once per request', async () => {
  const { scope, provider, at } = await setup();
  const { createThrough } = await helpers;
  const request = { workspaceId: scope.workspaceId, parentId: entryIdOf('notes'), extension: 'md', origin: 'workspace', idempotencyKey: 'op-1' };
  const record = await createThrough(provider, scope, request);
  await assertValid('ResourceRecord', record);
  assert.equal(record.relativePath, 'notes/Untitled-001.md');
  assert.equal((await createThrough(provider, scope, request)).fileId, record.fileId);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'a.md']);
  await assert.rejects(provider.create(scope, { ...request, workspaceId: 'ws_other' }), (e) => e.code === 'wrong-source');
});

test('a read-only local folder is never written to: the write is answered before it is attempted', { skip: !unprivileged }, async () => {
  const { service, scope, provider, at, project } = await setup({ 'a.md': 'FIRST_TEXT_B3\n' }, { readOnly: true });
  const { writeThrough, createThrough } = await helpers;
  const record = await service.registerEntry(scope.workspaceId, entryIdOf('a.md'));
  const result = await writeThrough(provider, scope, { fileId: record.fileId, baseSourceRevision: sha('FIRST_TEXT_B3\n'), representation: 'text', payload: 'x', opId: 'op-1' });
  assert.equal(result.status, 'unsupported');
  await assert.rejects(createThrough(provider, scope, { workspaceId: scope.workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: 'op-2' }), (e) => e.code === 'unsupported');
  assert.equal(fs.readFileSync(at('a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.deepEqual(fs.readdirSync(project), ['a.md']);
});

// ── what every caller does the same way ────────────────────────────────

for (const level of ['unknown', 'unsupported']) {
  test(`a source whose ability to update is ${level} is never asked to write`, async () => {
    const { writeThrough, createThrough } = await helpers;
    let writes = 0;
    let creations = 0;
    const capabilities = { list: 'supported', read: 'supported', create: level, update: level, move: level, trash: level, conditionalWrite: level, pagePatch: level, changes: level, uploadCustomType: level };
    const provider = { capabilities: async () => capabilities, write: async () => { writes++; return { status: 'saved', sourceRevision: 'r2', contentHash: sha('x') }; }, create: async () => { creations++; return {}; } };
    const result = await writeThrough(provider, spaceScope, { fileId: 'file_1', baseSourceRevision: 'r1', representation: 'text', payload: 'x', opId: 'op-1' });
    await assertValid('SourceWriteResult', result);
    assert.equal(result.status, 'unsupported');
    await assert.rejects(createThrough(provider, spaceScope, { workspaceId: 'ws_space', extension: 'md', origin: 'workspace', idempotencyKey: 'op-2' }), (e) => e.code === 'unsupported');
    assert.deepEqual([writes, creations], [0, 0]);
  });
}

test('a source that can update files but not pages is not asked to patch a page', async () => {
  const { writeThrough } = await helpers;
  let writes = 0;
  const capabilities = { list: 'supported', read: 'supported', create: 'supported', update: 'supported', move: 'unknown', trash: 'unknown', conditionalWrite: 'supported', pagePatch: 'unknown', changes: 'unknown', uploadCustomType: 'unknown' };
  const provider = { capabilities: async () => capabilities, write: async () => { writes++; return { status: 'saved', sourceRevision: 'r2', contentHash: sha('x') }; } };
  assert.equal((await writeThrough(provider, spaceScope, { fileId: 'obj_page', baseSourceRevision: 'r1', representation: 'blocks', payload: [], opId: 'op-1' })).status, 'unsupported');
  assert.equal(writes, 0);
  assert.equal((await writeThrough(provider, spaceScope, { fileId: 'obj_file', baseSourceRevision: 'r1', representation: 'text', payload: 'x', opId: 'op-2' })).status, 'saved');
  assert.equal(writes, 1);
});

test('a listing that could not be read whole is partial, even with nothing in it: not an empty folder', async () => {
  const { collectPages } = await helpers;
  const nothing = { list: async () => ({ entries: [], nextCursor: null, completeness: 'partial' }) };
  assert.deepEqual(await collectPages(nothing, spaceScope), { entries: [], completeness: 'partial' });
  // one partial page among complete ones makes the whole listing partial
  const pages = { undefined: { entries: [{ entryId: 'e1' }], nextCursor: 'c2', completeness: 'complete' }, c2: { entries: [{ entryId: 'e2' }], nextCursor: null, completeness: 'partial' } };
  const mixed = await collectPages({ list: async (_s, _p, cursor) => pages[String(cursor)] }, spaceScope);
  assert.deepEqual([mixed.entries.length, mixed.completeness], [2, 'partial']);
});

test('a source that hands back a cursor it already gave is an error, not an endless listing', async () => {
  const { collectPages } = await helpers;
  const looping = { list: async () => ({ entries: [{ entryId: 'e1' }], nextCursor: 'again', completeness: 'complete' }) };
  await assert.rejects(collectPages(looping, spaceScope), /repeated a listing cursor/);
});

test('the revision a write names is the source\'s own version where it has one, else the content hash', async () => {
  const { writeBaseOf } = await helpers;
  assert.equal(writeBaseOf({ sourceRevision: 'r42', contentHash: sha('x') }), 'r42');
  assert.equal(writeBaseOf({ sourceRevision: null, contentHash: sha('x') }), sha('x'));
});

test('a remote object and a local file of the same name are different resources, and no key is built by joining', async () => {
  const { locatorKey } = await helpers;
  const local = { kind: 'local', rootGrantId: 'grant_1', relativePath: 'notes/a.md' };
  const remote = { kind: 'chatgpt-space', connectionRef: 'conn_1', accountScope: 'acct_1', spaceId: 'space_1', objectId: 'notes/a.md', objectKind: 'file' };
  assert.notEqual(locatorKey(local), locatorKey(remote));
  assert.equal(locatorKey(local), locatorKey({ ...local }));
  // two locators a naive join would confuse
  assert.notEqual(locatorKey({ kind: 'local', rootGrantId: 'g:1', relativePath: 'x' }), locatorKey({ kind: 'local', rootGrantId: 'g', relativePath: '1:x' }));
  assert.notEqual(locatorKey({ ...remote, spaceId: 'a', objectId: 'b/c' }), locatorKey({ ...remote, spaceId: 'a/b', objectId: 'c' }));
  // another account's object with the same ids is another resource
  assert.notEqual(locatorKey(remote), locatorKey({ ...remote, accountScope: 'acct_2' }));
  assert.throws(() => locatorKey({ kind: 'cloud-drive' }), /not a resource locator/);
});

// ── the registry, and the space that cannot be reached ─────────────────

test('the registry answers by kind; a kind nobody registered is refused, never sent to the disk', async () => {
  const { registry, scope, provider } = await setup();
  assert.deepEqual(registry.kinds(), ['chatgpt-space', 'local']);
  assert.notEqual(registry.providerOf(spaceScope), provider);
  assert.throws(() => registry.providerOf({ ...scope, kind: 'cloud-drive' }), (e) => e.code === 'unknown-source');
  assert.throws(() => registry.providerOf(null), (e) => e.code === 'unknown-source');
  const found = await registry.providerFor(scope.workspaceId);
  assert.deepEqual(found.scope, scope);
  assert.equal(found.provider, provider);
  await assert.rejects(registry.providerFor('ws_not_open'), (e) => e.code === 'no-grant');
});

test('the local provider does not answer for a space, whatever its object ids look like', async () => {
  const { provider } = await setup();
  const pathLike = { ...spaceScope, rootObjectId: '../../etc/passwd' };
  await assert.rejects(provider.list(pathLike), (e) => e.code === 'wrong-source');
  await assert.rejects(provider.read(pathLike, 'notes/a.md'), (e) => e.code === 'wrong-source');
  await assert.rejects(provider.capabilities(pathLike), (e) => e.code === 'wrong-source');
});

test('the space is blocked: capabilities unknown, the reason given, and never an empty listing', async () => {
  const { registry } = await setup();
  const space = registry.providerOf(spaceScope);
  const capabilities = await space.capabilities(spaceScope);
  await assertValid('SourceCapabilities', capabilities);
  assert.deepEqual([...new Set(Object.values(capabilities))], ['unknown']);
  for (const call of [() => space.list(spaceScope), () => space.read(spaceScope, 'obj_1'), () => space.create(spaceScope, {})]) {
    await assert.rejects(call(), (e) => e.code === 'blocked' && /no interface/.test(e.message));
  }
  const written = await space.write(spaceScope, { fileId: 'obj_1', baseSourceRevision: 'r1', representation: 'text', payload: 'x', opId: 'op-1' });
  await assertValid('SourceWriteResult', written);
  assert.equal(written.status, 'unsupported');
  const report = await space.diagnose(spaceScope);
  await assertValid('SpaceCapabilityReport', report);
  assert.deepEqual(report.gates, { read: 'blocked', write: 'blocked' });
  // and through the helpers a caller would use
  const { collectPages, writeThrough } = await helpers;
  await assert.rejects(collectPages(space, spaceScope), (e) => e.code === 'blocked');
  assert.equal((await writeThrough(space, spaceScope, { fileId: 'obj_1', baseSourceRevision: 'r1', representation: 'text', payload: 'x', opId: 'op-2' })).status, 'unsupported');
});

test('a real provider takes the blocked one\'s place in the registry; nothing else changes', async () => {
  const { service } = await setup();
  const reachable = { capabilities: async () => ({}), list: async () => ({ entries: [], nextCursor: null, completeness: 'complete' }) };
  const registry = createProviderRegistry({ service, providers: { 'chatgpt-space': reachable } });
  assert.equal(registry.providerOf(spaceScope), reachable);
  const { collectPages } = await helpers;
  assert.deepEqual(await collectPages(registry.providerOf(spaceScope), spaceScope), { entries: [], completeness: 'complete' });
});

// ── records from before locators ───────────────────────────────────────

test('a registry written as 1.0 is read with its identities kept, and rewritten as 1.1 on its next change', async () => {
  const { service, scope, project } = await setup();
  const file = path.join(project, '.thoughtdag', 'resources.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: '1.0', workspaceId: scope.workspaceId, resources: [
    { record: { fileId: 'file_from_1_0', workspaceId: scope.workspaceId, relativePath: 'notes/a.md', mediaType: 'text/markdown', origin: 'workspace', status: 'ready', revision: null } },
  ] }));
  assert.equal((await service.listChildren(scope.workspaceId, entryIdOf('notes')))[0].fileId, 'file_from_1_0');
  assert.equal((await service.readText('file_from_1_0')).text, 'FIRST_TEXT_B3\n');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.schemaVersion, '1.1');
  assert.deepEqual(stored.resources[0].record.locator, { kind: 'local', rootGrantId: scope.rootGrantId, relativePath: 'notes/a.md' });
  assert.equal(stored.resources[0].record.sourceRevision, null);
});
