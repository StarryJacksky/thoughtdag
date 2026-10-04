// What happens to a registered file when another program edits, renames,
// moves or deletes it, on real temp folders. The watcher's events are fed by
// hand: what is under test is what a signal leads to, not the operating
// system's event delivery (one case at the end uses the real watcher).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createWorkspaceService, entryIdOf } = require('../../runtime/workspace/index.cjs');
const { watchWorkspace, isOwnNoise } = require('../../runtime/workspace/watch.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-reconcile-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const sha = (content) => 'sha256:' + createHash('sha256').update(content).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serial = 0;
/** A project folder, an open workspace, and a watcher whose events the test sends itself. */
async function setup(files = { 'notes/a.md': 'FIRST_TEXT_B3\n', 'papers/keep.md': 'KEEP_TEXT_C4\n' }, serviceOptions = {}) {
  const id = ++serial;
  const project = path.join(base, `project-${id}`);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  }
  const fakeWatch = { fire: null, closed: 0, started: 0 };
  const watchFn = (_root, _options, onEvent) => { fakeWatch.started++; fakeWatch.fire = onEvent; return { close: () => { fakeWatch.closed++; }, on: () => {} }; };
  const service = createWorkspaceService({ stateDir: path.join(base, `state-${id}`), pickDirectory: async () => project, watch: { watchFn, quietMs: 15 }, ...serviceOptions });
  const workspace = await service.chooseRoot();
  const at = (rel) => path.join(project, rel);
  const open = async (rel) => {
    const record = await service.registerEntry(workspace.workspaceId, entryIdOf(rel));
    return { record, ...(await service.readText(record.fileId)) };
  };
  const events = [];
  const subscribe = () => service.subscribeWorkspace(workspace.workspaceId, (event) => events.push(event));
  /** Send watcher events and wait for the rescan they lead to. */
  const signal = async (...filenames) => { for (const f of filenames) fakeWatch.fire('change', f); await pause(80); };
  return { project, service, workspace, at, open, events, subscribe, signal, fakeWatch };
}

async function assertValid(kind, value) {
  const { validateDTO } = await loadContracts();
  const result = validateDTO(kind, value);
  assert.ok(result.ok, `${kind}: ${JSON.stringify(result.errors)}`);
}
const brief = (events) => events.map((e) => [e.change, e.record.relativePath, e.record.status, e.opId]);

// ── edits ──────────────────────────────────────────────────────────────

test('an edit by another program is announced once, however many signals arrive, and not again', async () => {
  const { open, at, events, subscribe, signal } = await setup();
  const read = await open('notes/a.md');
  await subscribe();
  fs.writeFileSync(at('notes/a.md'), 'EXTERNAL_EDIT_E6\n');
  await signal('notes/a.md', 'notes/a.md', 'notes/a.md');
  assert.equal(events.length, 1);
  await assertValid('WorkspaceEvent', events[0]);
  assert.deepEqual({ fileId: events[0].fileId, change: events[0].change, observedRevision: events[0].observedRevision, opId: events[0].opId },
    { fileId: read.record.fileId, change: 'content', observedRevision: sha('EXTERNAL_EDIT_E6\n'), opId: null });
  await signal('notes/a.md');
  assert.equal(events.length, 1);
});

test('this application\'s own save is announced once with its operation id; the signal that follows adds nothing', async () => {
  const { service, open, events, subscribe, signal } = await setup();
  const read = await open('notes/a.md');
  await subscribe();
  await service.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  await signal('notes/a.md');
  assert.deepEqual(events.map((e) => [e.change, e.opId, e.observedRevision]), [['content', 'op-1', sha('SECOND_TEXT_D5\n')]]);
});

test('an editor that saves by replacing the file is still the same document', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  fs.writeFileSync(at('notes/a.md.editor-tmp'), 'REPLACED_BY_EDITOR_N7\n');
  fs.renameSync(at('notes/a.md.editor-tmp'), at('notes/a.md')); // a new file under the old name
  const record = await service.reconcile(read.record.fileId);
  assert.deepEqual([record.fileId, record.status, record.revision], [read.record.fileId, 'ready', sha('REPLACED_BY_EDITOR_N7\n')]);
  assert.equal((await service.readText(read.record.fileId)).text, 'REPLACED_BY_EDITOR_N7\n');
});

// ── renames and moves ──────────────────────────────────────────────────

test('a file renamed or moved by another program keeps its identity: the record follows it', async () => {
  const { service, open, at, events, subscribe } = await setup();
  const read = await open('notes/a.md');
  await subscribe();
  fs.renameSync(at('notes/a.md'), at('notes/renamed.md'));
  let record = await service.reconcile(read.record.fileId);
  assert.deepEqual([record.fileId, record.relativePath, record.status], [read.record.fileId, 'notes/renamed.md', 'ready']);
  fs.renameSync(at('notes/renamed.md'), at('papers/moved.md'));
  record = await service.reconcile(read.record.fileId);
  assert.equal(record.relativePath, 'papers/moved.md');
  assert.equal(record.locator.relativePath, 'papers/moved.md');
  assert.deepEqual(brief(events), [['moved', 'notes/renamed.md', 'ready', null], ['moved', 'papers/moved.md', 'ready', null]]);
  assert.equal((await service.readText(read.record.fileId)).text, 'FIRST_TEXT_B3\n');
});

test('a rename that only changes case is followed', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  fs.renameSync(at('notes/a.md'), at('notes/A.md'));
  assert.equal((await service.reconcile(read.record.fileId)).relativePath, 'notes/A.md');
});

test('names outside ASCII are followed like any other', async () => {
  const { service, open, at } = await setup({ 'notes/笔记-é.md': 'UNICODE_NAME_P9\n' });
  const read = await open('notes/笔记-é.md');
  fs.renameSync(at('notes/笔记-é.md'), at('notes/研究-ü.md'));
  const record = await service.reconcile(read.record.fileId);
  assert.deepEqual([record.relativePath, record.status], ['notes/研究-ü.md', 'ready']);
});

test('a file with the same name somewhere else is not taken for the lost one', async () => {
  const { service, open, at, events, subscribe } = await setup();
  const read = await open('notes/a.md');
  await subscribe();
  fs.rmSync(at('notes/a.md'));
  fs.writeFileSync(at('papers/a.md'), 'A_DIFFERENT_FILE_Q2\n');
  const record = await service.reconcile(read.record.fileId);
  assert.deepEqual([record.status, record.relativePath], ['missing', 'notes/a.md']);
  assert.deepEqual(brief(events), [['missing', 'notes/a.md', 'missing', null]]);
});

test('a file that comes back as a new file elsewhere is found by its content when exactly one file holds it', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  fs.copyFileSync(at('notes/a.md'), at('papers/a-archived.md')); // what a move across disks leaves: a new file, the same bytes
  fs.rmSync(at('notes/a.md'));
  const record = await service.reconcile(read.record.fileId);
  assert.deepEqual([record.relativePath, record.status], ['papers/a-archived.md', 'ready']);
});

test('two files that both hold its content are an ambiguity, not a guess; the person settles it', async () => {
  const { service, open, at, events, subscribe } = await setup();
  const read = await open('notes/a.md');
  await subscribe();
  fs.copyFileSync(at('notes/a.md'), at('papers/copy-1.md'));
  fs.copyFileSync(at('notes/a.md'), at('papers/copy-2.md'));
  fs.rmSync(at('notes/a.md'));
  const lost = await service.reconcile(read.record.fileId);
  assert.deepEqual([lost.status, lost.relativePath], ['ambiguous', 'notes/a.md']);
  await assert.rejects(service.readText(read.record.fileId), (e) => e.code === 'lost');
  const found = await service.relink(read.record.fileId, entryIdOf('papers/copy-2.md'));
  assert.deepEqual([found.fileId, found.relativePath, found.status], [read.record.fileId, 'papers/copy-2.md', 'ready']);
  assert.deepEqual(brief(events), [['ambiguous', 'notes/a.md', 'ambiguous', null], ['restored', 'papers/copy-2.md', 'ready', null]]);
});

test('an empty file is never found by content', async () => {
  const { service, open, at } = await setup({ 'notes/empty.md': '', 'notes/a.md': 'x' });
  const read = await open('notes/empty.md');
  fs.copyFileSync(at('notes/empty.md'), at('notes/also-empty.md'));
  fs.rmSync(at('notes/empty.md'));
  assert.equal((await service.reconcile(read.record.fileId)).status, 'missing');
});

// ── deleted, re-created, put back ──────────────────────────────────────

test('a file deleted and re-created at the same path with other content does not inherit the identity', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  fs.rmSync(at('notes/a.md'));
  assert.equal((await service.reconcile(read.record.fileId)).status, 'missing');
  fs.writeFileSync(at('notes/placeholder.md'), 'takes the freed slot'); // so the new file is not handed the old one's place on disk
  fs.writeFileSync(at('notes/a.md'), 'A_DIFFERENT_FILE_Q2\n');
  assert.equal((await service.reconcile(read.record.fileId)).status, 'missing');
  // while it is lost, the path's new occupant is not read or written under its identity
  await assert.rejects(service.readText(read.record.fileId), (e) => e.code === 'lost');
  assert.deepEqual(await service.saveText(read.record.fileId, read.revision, 'OVERWRITE\n', 'op-1'), { status: 'conflict', currentRevision: null });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'A_DIFFERENT_FILE_Q2\n');
  // the person may say it is the one after all
  const relinked = await service.relink(read.record.fileId, entryIdOf('notes/a.md'));
  assert.deepEqual([relinked.status, relinked.revision], ['ready', sha('A_DIFFERENT_FILE_Q2\n')]);
});

test('the same file put back is recognized, and so is one that holds the same content', async () => {
  const { service, open, at, project } = await setup();
  const read = await open('notes/a.md');
  const parked = path.join(path.dirname(project), `parked-${path.basename(project)}.md`);
  fs.renameSync(at('notes/a.md'), parked);
  assert.equal((await service.reconcile(read.record.fileId)).status, 'missing');
  fs.renameSync(parked, at('notes/a.md')); // the very same file
  assert.equal((await service.reconcile(read.record.fileId)).status, 'ready');

  fs.rmSync(at('notes/a.md'));
  assert.equal((await service.reconcile(read.record.fileId)).status, 'missing');
  fs.writeFileSync(at('notes/a.md'), 'FIRST_TEXT_B3\n'); // a new file, the same content
  assert.equal((await service.reconcile(read.record.fileId)).status, 'ready');
});

// ── relink, rescan ─────────────────────────────────────────────────────

test('a lost file is not relinked to another registered file, to a folder, or to a place outside', async () => {
  const { service, open, at } = await setup();
  const read = await open('notes/a.md');
  await open('papers/keep.md');
  fs.rmSync(at('notes/a.md'));
  await service.reconcile(read.record.fileId);
  await assert.rejects(service.relink(read.record.fileId, entryIdOf('papers/keep.md')), (e) => e.code === 'claimed');
  await assert.rejects(service.relink(read.record.fileId, entryIdOf('papers')), (e) => e.code === 'not-a-file');
  await assert.rejects(service.relink(read.record.fileId, entryIdOf('../outside.md')), (e) => e.code === 'traversal');
  assert.equal((await service.reconcile(read.record.fileId)).status, 'missing');
});

test('a rescan reports every change in one pass, and nothing when nothing changed', async () => {
  const { service, workspace, open, at } = await setup();
  const a = await open('notes/a.md');
  const keep = await open('papers/keep.md');
  fs.writeFileSync(at('notes/a.md'), 'EXTERNAL_EDIT_E6\n');
  fs.rmSync(at('papers/keep.md'));
  const changed = await service.rescanWorkspace(workspace.workspaceId);
  assert.deepEqual(changed.map((r) => [r.fileId, r.status]).sort(), [[a.record.fileId, 'ready'], [keep.record.fileId, 'missing']].sort());
  assert.deepEqual(await service.rescanWorkspace(workspace.workspaceId), []);
});

test('a moved file\'s identity survives a restart', async () => {
  const { service, workspace, open, at, project } = await setup();
  const read = await open('notes/a.md');
  fs.renameSync(at('notes/a.md'), at('papers/moved.md'));
  await service.reconcile(read.record.fileId);
  const restarted = createWorkspaceService({ stateDir: path.join(base, `state-${path.basename(project).split('-')[1]}`), pickDirectory: async () => project });
  assert.equal((await restarted.listChildren(workspace.workspaceId, entryIdOf('papers'))).find((e) => e.name === 'moved.md').fileId, read.record.fileId);
});

// ── the watcher ────────────────────────────────────────────────────────

test('the workspace\'s own records and temp files are not a signal; an unnamed event is', () => {
  assert.equal(isOwnNoise('.thoughtdag/resources.json'), true);
  assert.equal(isOwnNoise('.ThoughtDAG\\journal.jsonl'), true);
  assert.equal(isOwnNoise('notes/.a.md.tdag-save-1a2b3c4d'), true);
  assert.equal(isOwnNoise('notes/a.md'), false);
  assert.equal(isOwnNoise(null), false);
});

test('a burst of events is one signal, and noise is none', async () => {
  let fire;
  let signals = 0;
  const watcher = watchWorkspace({ rootPath: base, onSignal: () => { signals++; }, quietMs: 15, watchFn: (_root, _options, onEvent) => { fire = onEvent; return { close: () => {}, on: () => {} }; } });
  for (let i = 0; i < 5; i++) fire('change', 'notes/a.md');
  fire('rename', '.thoughtdag/journal.jsonl');
  await pause(60);
  assert.equal(signals, 1);
  fire('change', '.thoughtdag/resources.json');
  await pause(60);
  assert.equal(signals, 1);
  watcher.close();
  fire('change', 'notes/a.md');
  await pause(60);
  assert.equal(signals, 1);
});

test('the watcher starts with the first subscriber and stops with the last, or when the workspace closes', async () => {
  const { service, workspace, subscribe, fakeWatch } = await setup();
  assert.equal(fakeWatch.started, 0);
  const one = await subscribe();
  const two = await subscribe();
  assert.equal(fakeWatch.started, 1);
  one();
  assert.equal(fakeWatch.closed, 0);
  two();
  assert.equal(fakeWatch.closed, 1);
  await subscribe();
  await service.closeWorkspace(workspace.workspaceId);
  assert.equal(fakeWatch.closed, 2);
});

test('a platform that cannot watch a folder tree leaves explicit rescans working', async () => {
  const { service, workspace, open, at, subscribe } = await setup(undefined, { watch: { watchFn: () => { throw new Error('recursive watching is not supported'); } } });
  const read = await open('notes/a.md');
  await subscribe();
  fs.writeFileSync(at('notes/a.md'), 'EXTERNAL_EDIT_E6\n');
  assert.deepEqual((await service.rescanWorkspace(workspace.workspaceId)).map((r) => r.fileId), [read.record.fileId]);
});

test('the real watcher notices an edit by another program', async () => {
  const id = ++serial;
  const project = path.join(base, `project-${id}`);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'a.md'), 'FIRST_TEXT_B3\n');
  const service = createWorkspaceService({ stateDir: path.join(base, `state-${id}`), pickDirectory: async () => project, watch: { quietMs: 50 } });
  const workspace = await service.chooseRoot();
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('a.md'));
  await service.readText(record.fileId);
  const events = [];
  const unsubscribe = await service.subscribeWorkspace(workspace.workspaceId, (event) => events.push(event));
  try {
    await pause(150); // let the watcher settle before the change
    fs.writeFileSync(path.join(project, 'a.md'), 'EXTERNAL_EDIT_E6\n');
    for (let waited = 0; waited < 5000 && events.length === 0; waited += 100) await pause(100);
    assert.deepEqual(events.map((e) => [e.change, e.observedRevision]), [['content', sha('EXTERNAL_EDIT_E6\n')]]);
  } finally {
    unsubscribe();
  }
});
