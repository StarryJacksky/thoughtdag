// File operations through the workspace service, on real temp folders: what
// creating, reading, saving, moving, copying and trashing do, what they
// refuse, and what is left on disk when something goes wrong part-way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createWorkspaceService, entryIdOf } = require('../../runtime/workspace/index.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const posix = process.platform !== 'win32';
const unprivileged = posix && process.getuid() !== 0;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-fileops-')));
test.after(() => {
  for (const dir of fs.readdirSync(base)) { try { fs.chmodSync(path.join(base, dir), 0o755); } catch { /* not a directory */ } }
  fs.rmSync(base, { recursive: true, force: true });
});

const sha = (content) => 'sha256:' + createHash('sha256').update(content).digest('hex');
const errno = (code) => Object.assign(new Error(code), { code });

let serial = 0;
/** A fresh project folder with an open workspace over it. `options` reach the service. */
async function setup(options = {}) {
  const id = ++serial;
  const project = path.join(base, `project-${id}`);
  const stateDir = path.join(base, `state-${id}`);
  for (const [rel, content] of Object.entries({ 'notes/a.md': 'FIRST_TEXT_B3\n', 'papers/keep.md': 'KEEP_TEXT_C4\n' })) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  }
  const start = (more = {}) => createWorkspaceService({ stateDir, pickDirectory: async () => project, ...options, ...more });
  const service = start();
  const workspace = await service.chooseRoot();
  const at = (rel) => path.join(project, rel);
  const request = (key, more = {}) => ({ workspaceId: workspace.workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: key, ...more });
  const open = async (rel, s = service) => {
    const record = await s.registerEntry(workspace.workspaceId, entryIdOf(rel));
    return { record, ...(await s.readText(record.fileId)) };
  };
  return { project, service, workspace, start, at, request, open, notes: entryIdOf('notes'), papers: entryIdOf('papers') };
}

async function assertValid(kind, value) {
  const { validateDTO } = await loadContracts();
  const result = validateDTO(kind, value);
  assert.ok(result.ok, `${kind}: ${JSON.stringify(result.errors)}`);
}
/** Files in a folder that a person would see: no dot-files this module made and left behind. */
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tdag-'));

// ── creating ───────────────────────────────────────────────────────────

test('two files created at once get two names and two identities', async () => {
  const { service, request, at, notes } = await setup();
  const [one, two] = await Promise.all([service.createFile(request('op-1', { parentId: notes })), service.createFile(request('op-2', { parentId: notes }))]);
  assert.deepEqual([one.relativePath, two.relativePath].sort(), ['notes/Untitled-001.md', 'notes/Untitled-002.md']);
  assert.notEqual(one.fileId, two.fileId);
  assert.ok(fs.existsSync(at('notes/Untitled-001.md')) && fs.existsSync(at('notes/Untitled-002.md')));
  await assertValid('ResourceRecord', one);
  assert.equal(one.revision, sha(''));
});

test('the same request asked again returns the same file and makes no second one, across a restart too', async () => {
  const { service, start, request, at, notes } = await setup();
  const first = await service.createFile(request('op-1', { parentId: notes }));
  assert.equal((await service.createFile(request('op-1', { parentId: notes }))).fileId, first.fileId);
  assert.equal((await start().createFile(request('op-1', { parentId: notes }))).fileId, first.fileId);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'a.md']);
});

test('a file created from the graph lands in Graph Files, whatever folder was named', async () => {
  const { service, request, at, notes } = await setup();
  const record = await service.createFile(request('op-1', { origin: 'graph', parentId: notes, extension: 'tex' }));
  assert.equal(record.relativePath, 'Graph Files/Untitled-001.tex');
  assert.equal(record.origin, 'graph');
  assert.ok(fs.existsSync(at('Graph Files/Untitled-001.tex')));
});

test('a new file starts as the smallest legal content of its type', async () => {
  const { service, request, at } = await setup();
  const made = {};
  for (const extension of ['md', 'json', 'html', 'tdmap']) made[extension] = await service.createFile(request(`op-${extension}`, { extension }));
  assert.equal(fs.readFileSync(at(made.md.relativePath), 'utf8'), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(at(made.json.relativePath), 'utf8')), {});
  assert.match(fs.readFileSync(at(made.html.relativePath), 'utf8'), /^<!doctype html>/);
  assert.equal(made.tdmap.relativePath, 'Mindmap-001.tdmap');
  assert.equal(made.tdmap.mediaType, 'application/vnd.thoughtdag.mindmap+json');
  const map = JSON.parse(fs.readFileSync(at(made.tdmap.relativePath), 'utf8'));
  assert.equal(map.format, 'thoughtdag-mindmap');
  assert.equal(map.schemaVersion, '1.0');
  assert.deepEqual(map.roots, ['n1']);
  assert.deepEqual(map.nodes, [{ id: 'n1', text: '', children: [] }]);
});

test('a request that names a path, or an origin only the host assigns, is refused before anything is made', async () => {
  const { service, request, project } = await setup();
  const before = fs.readdirSync(project, { recursive: true }).sort();
  await assert.rejects(service.createFile(request('op-1', { path: '/etc/passwd' })), (e) => e.code === 'invalid-request');
  await assert.rejects(service.createFile(request('op-2', { origin: 'import' })), (e) => e.code === 'invalid-request');
  await assert.rejects(service.createFile(request('op-3', { extension: '../sh' })), (e) => e.code === 'invalid-request');
  await assert.rejects(service.createFile(request('op-4', { parentId: entryIdOf('../outside') })), (e) => e.code === 'traversal');
  assert.deepEqual(fs.readdirSync(project, { recursive: true }).filter((n) => !n.startsWith('.thoughtdag')).sort(), before.filter((n) => !n.startsWith('.thoughtdag')));
});

// ── reading ────────────────────────────────────────────────────────────

test('reading returns the text and the hash of the bytes as its revision', async () => {
  const { open } = await setup();
  const read = await open('notes/a.md');
  await assertValid('TextRevision', { text: read.text, revision: read.revision, encoding: read.encoding, newline: read.newline });
  assert.deepEqual({ text: read.text, revision: read.revision, encoding: read.encoding, newline: read.newline }, { text: 'FIRST_TEXT_B3\n', revision: sha('FIRST_TEXT_B3\n'), encoding: 'utf-8', newline: 'lf' });
});

test('line endings and a byte-order mark are reported, and the mark is not part of the text', async () => {
  const { open, at } = await setup();
  fs.writeFileSync(at('notes/crlf.md'), 'one\r\ntwo\r\n');
  fs.writeFileSync(at('notes/mixed.md'), 'one\r\ntwo\n');
  fs.writeFileSync(at('notes/bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('marked\n')]));
  assert.equal((await open('notes/crlf.md')).newline, 'crlf');
  assert.equal((await open('notes/mixed.md')).newline, 'mixed');
  const bom = await open('notes/bom.md');
  assert.deepEqual([bom.text, bom.encoding], ['marked\n', 'utf-8-bom']);
});

test('text that is not UTF-8 is not opened for editing and is never overwritten', async () => {
  const { service, open, at, workspace } = await setup();
  const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
  fs.writeFileSync(at('notes/latin1.txt'), latin1);
  await assert.rejects(open('notes/latin1.txt'), (e) => e.code === 'not-utf8');
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/latin1.txt'));
  const result = await service.saveText(record.fileId, sha(latin1), 'cafe\n', 'op-1');
  assert.equal(result.status, 'error');
  assert.deepEqual(fs.readFileSync(at('notes/latin1.txt')), latin1);
});

test('a file above the editing limit is not opened for editing', async () => {
  const { open, at } = await setup();
  fs.writeFileSync(at('notes/big.txt'), '');
  fs.truncateSync(at('notes/big.txt'), 8 * 1024 * 1024 + 1);
  await assert.rejects(open('notes/big.txt'), (e) => e.code === 'too-large');
});

// ── saving ─────────────────────────────────────────────────────────────

test('a save that names the revision it read replaces the content and keeps what was there', async () => {
  const { service, open, at, project } = await setup();
  if (posix) fs.chmodSync(at('notes/a.md'), 0o600);
  const read = await open('notes/a.md');
  const result = await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  await assertValid('SaveResult', result);
  assert.deepEqual(result, { status: 'saved', revision: sha('SECOND_TEXT_D5\n'), sourceRevision: null });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
  if (posix) assert.equal(fs.statSync(at('notes/a.md')).mode & 0o777, 0o600);
  const kept = path.join(project, '.thoughtdag', 'recovery', 'versions', read.record.fileId, read.revision.slice('sha256:'.length));
  assert.equal(fs.readFileSync(kept, 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal((await service.readText(read.record.fileId)).revision, result.revision);
  assert.deepEqual(leftovers(at('notes')), []);
});

test('a save that names a stale revision is a conflict and leaves the file alone', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  fs.writeFileSync(at('notes/a.md'), 'EXTERNAL_EDIT_E6\n');
  const result = await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  await assertValid('SaveResult', result);
  assert.deepEqual(result, { status: 'conflict', currentRevision: sha('EXTERNAL_EDIT_E6\n') });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'EXTERNAL_EDIT_E6\n');
  assert.deepEqual(leftovers(at('notes')), []);
});

test('a change that lands while the save is under way is a conflict, and the change survives', async () => {
  let project;
  const io = {
    ...fs.promises,
    open: async (file, flags, mode) => {
      // another program writes the file just as the save prepares its replacement
      if (String(file).includes('.tdag-save-')) fs.writeFileSync(path.join(project, 'notes', 'a.md'), 'EXTERNAL_EDIT_E6\n');
      return fs.promises.open(file, flags, mode);
    },
  };
  const ctx = await setup({ io });
  project = ctx.project;
  const read = await ctx.open('notes/a.md');
  const result = await ctx.service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  assert.deepEqual(result, { status: 'conflict', currentRevision: sha('EXTERNAL_EDIT_E6\n') });
  assert.equal(fs.readFileSync(ctx.at('notes/a.md'), 'utf8'), 'EXTERNAL_EDIT_E6\n');
  assert.deepEqual(leftovers(ctx.at('notes')), []);
});

test('a byte-order mark survives a save', async () => {
  const { service, open, at } = await setup();
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  fs.writeFileSync(at('notes/bom.md'), Buffer.concat([bom, Buffer.from('marked\n')]));
  const read = await open('notes/bom.md');
  assert.equal((await service.saveText(read.record.fileId, read.revision, 'still marked\n', 'op-1')).status, 'saved');
  assert.deepEqual(fs.readFileSync(at('notes/bom.md')), Buffer.concat([bom, Buffer.from('still marked\n')]));
});

test('saving text the file already holds writes nothing', async () => {
  const { service, open, project } = await setup();
  const read = await open('notes/a.md');
  assert.deepEqual(await service.saveText(read.record.fileId, read.revision, 'FIRST_TEXT_B3\n', 'op-1'), { status: 'saved', revision: read.revision, sourceRevision: null });
  assert.equal(fs.existsSync(path.join(project, '.thoughtdag', 'recovery')), false);
});

test('the same save asked twice is one save, even though the first changed the revision', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  const first = await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  const again = await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  assert.deepEqual(again, first);
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
});

test('a full disk is an error and never a save: the file keeps its content and no temp file stays', async () => {
  const io = {
    ...fs.promises,
    open: async (file, flags, mode) => {
      const handle = await fs.promises.open(file, flags, mode);
      if (!String(file).includes('.tdag-save-')) return handle;
      handle.writeFile = async () => { throw errno('ENOSPC'); };
      return handle;
    },
  };
  const { service, open, at } = await setup({ io });
  const read = await open('notes/a.md');
  const result = await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  await assertValid('SaveResult', result);
  assert.deepEqual(result, { status: 'error', reason: 'the disk is full' });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.deepEqual(leftovers(at('notes')), []);
});

test('a file that cannot be written is readonly and never saved', async () => {
  const io = { ...fs.promises, open: async (file, flags, mode) => { if (String(file).includes('.tdag-save-')) throw errno('EACCES'); return fs.promises.open(file, flags, mode); } };
  const { service, open, at } = await setup({ io });
  const read = await open('notes/a.md');
  assert.deepEqual(await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1'), { status: 'readonly', reason: 'the file cannot be written' });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
});

test('a replacement that fails at the last step is an error; the old content stays and the save can be asked again', async () => {
  let fail = true;
  const io = { ...fs.promises, rename: async (from, to) => { if (fail && String(from).includes('.tdag-save-')) throw errno('EIO'); return fs.promises.rename(from, to); } };
  const { service, open, at } = await setup({ io });
  const read = await open('notes/a.md');
  assert.equal((await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1')).status, 'error');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.deepEqual(leftovers(at('notes')), []);
  fail = false;
  assert.equal((await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1')).status, 'saved');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
});

test('a file deleted behind the editor is a conflict, not a save', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  fs.rmSync(at('notes/a.md'));
  assert.deepEqual(await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1'), { status: 'conflict', currentRevision: null });
  assert.equal(fs.existsSync(at('notes/a.md')), false);
});

test('a read-only workspace refuses to create and reports readonly for a save', { skip: !unprivileged }, async () => {
  const id = ++serial;
  const project = path.join(base, `project-${id}`);
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.md'), 'FIRST_TEXT_B3\n');
  fs.chmodSync(project, 0o555);
  const service = createWorkspaceService({ stateDir: path.join(base, `state-${id}`), pickDirectory: async () => project });
  const workspace = await service.chooseRoot();
  assert.equal(workspace.readOnly, true);
  await assert.rejects(service.createFile({ workspaceId: workspace.workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: 'op-1' }), (e) => e.code === 'read-only');
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('a.md'));
  const read = await service.readText(record.fileId);
  assert.equal(read.text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(await service.saveText(record.fileId, read.revision, 'x', 'op-2'), { status: 'readonly', reason: 'this workspace is read-only' });
  assert.deepEqual(fs.readdirSync(project), ['a.md']);
});

// ── moving, copying, trashing ──────────────────────────────────────────

test('a moved file keeps its identity; the record follows it, across a restart too', async () => {
  const { service, start, open, at, workspace, papers } = await setup();
  const read = await open('notes/a.md');
  const moved = await service.moveFile(read.record.fileId, papers, 'renamed.md', 'op-1');
  await assertValid('ResourceRecord', moved);
  assert.equal(moved.fileId, read.record.fileId);
  assert.equal(moved.relativePath, 'papers/renamed.md');
  assert.deepEqual(moved.locator, { kind: 'local', rootGrantId: workspace.rootGrantId, relativePath: 'papers/renamed.md' });
  assert.equal(fs.existsSync(at('notes/a.md')), false);
  assert.equal(fs.readFileSync(at('papers/renamed.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  const restarted = start();
  assert.equal((await restarted.readText(read.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.equal((await restarted.listChildren(workspace.workspaceId, papers)).find((e) => e.name === 'renamed.md').fileId, read.record.fileId);
  // the same move asked again is not a second move
  assert.equal((await service.moveFile(read.record.fileId, papers, 'renamed.md', 'op-1')).relativePath, 'papers/renamed.md');
});

test('a move onto a name that is taken is refused and moves nothing', async () => {
  const { service, open, at, papers } = await setup();
  const read = await open('notes/a.md');
  await assert.rejects(service.moveFile(read.record.fileId, papers, 'keep.md', 'op-1'), (e) => e.code === 'exists');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal(fs.readFileSync(at('papers/keep.md'), 'utf8'), 'KEEP_TEXT_C4\n');
  await assert.rejects(service.moveFile(read.record.fileId, papers, 'CON', 'op-2'), (e) => e.code === 'reserved-name');
  await assert.rejects(service.moveFile(read.record.fileId, entryIdOf('../outside'), 'a.md', 'op-3'), (e) => e.code === 'traversal');
});

test('a copy is a new file with a new identity', async () => {
  const { service, open, at, papers } = await setup();
  const read = await open('notes/a.md');
  const copy = await service.copyFile(read.record.fileId, papers, 'copy.md', 'op-1');
  await assertValid('ResourceRecord', copy);
  assert.notEqual(copy.fileId, read.record.fileId);
  assert.equal(copy.relativePath, 'papers/copy.md');
  assert.equal(copy.revision, read.revision);
  assert.equal(fs.readFileSync(at('papers/copy.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal((await service.copyFile(read.record.fileId, papers, 'copy.md', 'op-1')).fileId, copy.fileId);
  await assert.rejects(service.copyFile(read.record.fileId, papers, 'keep.md', 'op-2'), (e) => e.code === 'exists');
});

test('with no system trash, a trashed file is kept in the recovery area and its record marked missing', async () => {
  const { service, open, at, project } = await setup();
  const read = await open('notes/a.md');
  const receipt = await service.trashFile(read.record.fileId, 'op-1');
  await assertValid('TrashReceipt', receipt);
  assert.deepEqual({ ...receipt, receiptId: null }, { receiptId: null, fileId: read.record.fileId, opId: 'op-1', location: 'project-recovery', restorable: true });
  assert.equal(fs.existsSync(at('notes/a.md')), false);
  assert.equal(fs.readFileSync(path.join(project, '.thoughtdag', 'recovery', 'trash', receipt.receiptId, 'a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  const stored = JSON.parse(fs.readFileSync(path.join(project, '.thoughtdag', 'resources.json'), 'utf8'));
  assert.equal(stored.resources.find((r) => r.record.fileId === read.record.fileId).record.status, 'missing');
  assert.deepEqual(await service.trashFile(read.record.fileId, 'op-1'), receipt);
});

test('the system trash is used when there is one, and the recovery area when it fails', async () => {
  const trashed = [];
  const works = await setup({ trash: async (absolute) => { trashed.push(path.basename(absolute)); fs.rmSync(absolute); } });
  const a = await works.open('notes/a.md');
  assert.equal((await works.service.trashFile(a.record.fileId, 'op-1')).location, 'system-trash');
  assert.deepEqual(trashed, ['a.md']);

  const broken = await setup({ trash: async () => { throw new Error('no trash on this volume'); } });
  const b = await broken.open('notes/a.md');
  const receipt = await broken.service.trashFile(b.record.fileId, 'op-1');
  assert.equal(receipt.location, 'project-recovery');
  assert.equal(fs.existsSync(broken.at('notes/a.md')), false);
  assert.ok(fs.existsSync(path.join(broken.project, '.thoughtdag', 'recovery', 'trash', receipt.receiptId, 'a.md')));
});

// ── importing a copy ───────────────────────────────────────────────────

test('imported text becomes an ordinary local file marked as a copy, with its stated origin', async () => {
  const { service, request, at, notes } = await setup();
  const text = '# Reading notes\n\nIMPORTED_COPY_M8\n';
  const record = await service.importText(request('op-1', { parentId: notes }), { text, name: 'Reading notes', provenance: { source: 'chatgpt-space', note: 'Reading notes (Lab space)' } });
  await assertValid('ResourceRecord', record);
  assert.equal(record.relativePath, 'notes/Reading notes.md');
  assert.equal(record.origin, 'import');
  assert.equal(record.importedFrom.source, 'chatgpt-space');
  assert.equal(record.importedFrom.note, 'Reading notes (Lab space)');
  assert.ok(!Number.isNaN(Date.parse(record.importedFrom.importedAt)));
  assert.equal(record.sourceRevision, null); // nothing ties it to the place it came from
  assert.equal(fs.readFileSync(at('notes/Reading notes.md'), 'utf8'), text);
  // it edits like any local file
  const read = await service.readText(record.fileId);
  assert.equal((await service.saveText(record.fileId, read.revision, text + 'edited\n', 'op-2')).status, 'saved');
  // a second copy under the same name does not replace the first
  const second = await service.importText(request('op-3', { parentId: notes }), { text: 'other', name: 'Reading notes', provenance: { source: 'chatgpt-space' } });
  assert.equal(second.relativePath, 'notes/Reading notes-2.md');
  assert.equal(fs.readFileSync(at('notes/Reading notes.md'), 'utf8'), text + 'edited\n');
});

test('an import with an origin nobody defined, or a name that is not portable, is refused and makes nothing', async () => {
  const { service, request, at, notes } = await setup();
  await assert.rejects(service.importText(request('op-1', { parentId: notes }), { text: 'x', provenance: { source: 'somewhere' } }), (e) => e.code === 'invalid-request');
  await assert.rejects(service.importText(request('op-2', { parentId: notes }), { text: 'x', name: 'a/b', provenance: { source: 'other' } }), (e) => e.code === 'invalid-name');
  await assert.rejects(service.importText(request('op-3', { parentId: notes }), { text: 42, provenance: { source: 'other' } }), (e) => e.code === 'invalid-request');
  assert.deepEqual(fs.readdirSync(at('notes')), ['a.md']);
});

// ── after a crash ──────────────────────────────────────────────────────

const journalOf = (project) => path.join(project, '.thoughtdag', 'journal.jsonl');
const journalLine = (entry) => JSON.stringify({ at: '2026-10-04T00:00:00Z', ...entry }) + '\n';

test('a file written before a crash and not yet registered is adopted; the retry returns it instead of making another', async () => {
  const { start, request, at, project, notes } = await setup();
  // the state a crash leaves between writing the file and registering it
  fs.writeFileSync(at('notes/Untitled-001.md'), '');
  fs.writeFileSync(journalOf(project),
    journalLine({ opId: 'op-1', kind: 'create', phase: 'intent', parent: 'notes', extension: 'md', origin: 'workspace' })
    + journalLine({ opId: 'op-1', kind: 'create', phase: 'created', relativePath: 'notes/Untitled-001.md', origin: 'workspace', revision: sha('') }));
  const record = await start().createFile(request('op-1', { parentId: notes }));
  assert.equal(record.relativePath, 'notes/Untitled-001.md');
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'a.md']);
});

test('a save cut short before the replacement leaves the old content, clears its temp file, and can be asked again', async () => {
  const { service, start, open, at, project } = await setup();
  const read = await open('notes/a.md');
  await service.saveText(read.record.fileId, read.revision, 'FIRST_TEXT_B3\n', 'warm-up'); // no change; the registry now holds the file
  fs.writeFileSync(at('notes/.a.md.tdag-save-crashed1'), 'SECOND_TEXT_D5\n');
  fs.appendFileSync(journalOf(project), journalLine({ opId: 'op-1', kind: 'save', phase: 'intent', fileId: read.record.fileId, base: read.revision, next: sha('SECOND_TEXT_D5\n'), temp: '.a.md.tdag-save-crashed1' }));
  const restarted = start();
  assert.equal((await restarted.readText(read.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(leftovers(at('notes')), []);
  assert.equal((await restarted.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1')).status, 'saved');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
});

test('a save cut short after the replacement is recognized as done, not reported as a conflict', async () => {
  const { start, open, at, project } = await setup();
  const read = await open('notes/a.md');
  fs.writeFileSync(at('notes/a.md'), 'SECOND_TEXT_D5\n');
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  fs.appendFileSync(journalOf(project), journalLine({ opId: 'op-1', kind: 'save', phase: 'intent', fileId: read.record.fileId, base: read.revision, next: sha('SECOND_TEXT_D5\n'), temp: '.a.md.tdag-save-crashed2' }));
  const result = await start().saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  assert.deepEqual(result, { status: 'saved', revision: sha('SECOND_TEXT_D5\n'), sourceRevision: null });
});

test('a line the crash left half-written does not hide what the journal recorded before it', async () => {
  const { service, start, request, at, project, notes } = await setup();
  const first = await service.createFile(request('op-1', { parentId: notes }));
  fs.appendFileSync(journalOf(project), '{"opId":"op-2","kind":"cre');
  const restarted = start();
  assert.equal((await restarted.createFile(request('op-1', { parentId: notes }))).fileId, first.fileId);
  // and the journal still takes new entries after the torn line
  assert.equal((await restarted.createFile(request('op-3', { parentId: notes }))).relativePath, 'notes/Untitled-002.md');
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'Untitled-002.md', 'a.md']);
});

test('an operation id is good for one kind of operation', async () => {
  const { service, open, request, notes } = await setup();
  const read = await open('notes/a.md');
  await service.createFile(request('op-1', { parentId: notes }));
  await assert.rejects(service.trashFile(read.record.fileId, 'op-1'), (e) => e.code === 'invalid-operation');
  await assert.rejects(service.trashFile(read.record.fileId, ''), (e) => e.code === 'invalid-operation');
});
