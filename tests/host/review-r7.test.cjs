// What the review of "an edit is announced once" found (its R7 number is kept
// in the test names): a read that found the record moved on while it was under
// way took that to mean its own finding had been announced. The two are not
// the same: another program may have saved twice. A read that comes back late
// looks at the disk again in step with everything else that looks at the file.
// On real temp folders, with a read held at a chosen step and no watcher: no
// later signal comes to the rescue. Nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, sha, entryIdOf } = require('./helpers/workspace-fixture.cjs');

const setup = fixture(test, 'review-r7');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withoutWatcher = { watch: { watchFn: () => ({ close: () => {}, on: () => {} }), quietMs: 3600_000 } };

/** File-system calls where one read of a file can be held: before it opens the file, or once it has its bytes. */
function heldRead() {
  const state = { at: null, reached: null, release: null };
  const hold = (at) => {
    state.at = at;
    return {
      reached: new Promise((resolve) => { state.reached = resolve; }),
      release: () => state.release?.(),
    };
  };
  const wait = async () => { const reached = state.reached; state.at = null; await new Promise((resolve) => { state.release = resolve; reached(); }); };
  const reading = (flags) => typeof flags === 'number';
  const io = {
    ...fs.promises,
    open: async (file, flags, ...rest) => {
      const mine = reading(flags) && String(file).endsWith('.md');
      if (mine && state.at === 'open') await wait();
      const handle = await fs.promises.open(file, flags, ...rest);
      if (mine && state.at === 'bytes') {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); if (state.at === 'bytes') await wait(); };
      }
      return handle;
    },
  };
  return { io, hold };
}

async function opened(extra = {}) {
  const held = heldRead();
  const made = await setup({ ...withoutWatcher, io: held.io, ...extra });
  const a = await made.open('notes/a.md');
  const events = [];
  await made.service.subscribeWorkspace(made.workspace.workspaceId, (event) => events.push(event));
  const contentEvents = () => events.filter((e) => e.change === 'content').map((e) => e.observedRevision);
  const revisionNow = async () => (await made.service.resourceRecord(a.record.fileId)).revision;
  return { ...made, ...held, a, events, contentEvents, revisionNow };
}

const entries = {
  readText: (service, fileId) => service.readText(fileId).then((r) => r.text),
  readBytes: (service, fileId) => service.readBytes(fileId).then((r) => Buffer.from(r.bytes).toString('utf8')),
  freezeFile: (service, fileId) => service.freezeFile(fileId).then((r) => Buffer.from(r.bytes ?? '').toString('utf8')),
};

for (const [name, read] of Object.entries(entries)) {
  test(`[R7-01] ${name}: another program saves twice while a read is under way, and the second save is announced from what the read found`, async () => {
    const { service, at, hold, a, contentEvents, revisionNow } = await opened();
    const point = hold('open');
    const reading = read(service, a.record.fileId);
    await point.reached; // the read has the record of A, and has not opened the file
    fs.writeFileSync(at('notes/a.md'), 'B\n');
    await service.reconcile(a.record.fileId); // B is registered and announced
    fs.writeFileSync(at('notes/a.md'), 'C\n');
    point.release();
    await reading;
    assert.equal(await revisionNow(), sha('C\n'));
    assert.deepEqual(contentEvents(), [sha('B\n'), sha('C\n')]);
  });
}

test('[R7-01] the other order: a read that found B comes back after C is registered: nothing goes back to B, and nothing false is said', async () => {
  const { service, at, hold, a, contentEvents, revisionNow } = await opened();
  fs.writeFileSync(at('notes/a.md'), 'B\n');
  const point = hold('bytes');
  const reading = service.readText(a.record.fileId);
  await point.reached; // the read holds the bytes of B
  fs.writeFileSync(at('notes/a.md'), 'C\n');
  await service.reconcile(a.record.fileId);
  point.release();
  assert.equal((await reading).text, 'B\n');
  assert.equal(await revisionNow(), sha('C\n'));
  assert.deepEqual(contentEvents(), [sha('C\n')]);
});

test('[R7-01] the other order, with this application\'s own save: a read that found the old content comes back after the save, and the save stands', async () => {
  const { service, at, hold, a, contentEvents, revisionNow } = await opened();
  fs.writeFileSync(at('notes/a.md'), 'B\n');
  await service.reconcile(a.record.fileId);
  const before = contentEvents().length;
  const point = hold('bytes');
  const reading = service.readBytes(a.record.fileId);
  await point.reached;
  const saved = await service.saveText(a.record.fileId, sha('B\n'), 'SAVED\n', 'op-save');
  assert.equal(saved.status, 'saved');
  point.release();
  await reading;
  assert.equal(await revisionNow(), sha('SAVED\n'));
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SAVED\n');
  assert.deepEqual(contentEvents().slice(before).filter((r) => r !== sha('SAVED\n')), []);
});

test('[R7-01] one version found by a read and a look at the file together is announced once', async () => {
  const { service, at, hold, a, contentEvents } = await opened();
  fs.writeFileSync(at('notes/a.md'), 'B\n');
  const point = hold('bytes');
  const reading = service.readText(a.record.fileId);
  await point.reached;
  await service.reconcile(a.record.fileId);
  point.release();
  await reading;
  await service.reconcile(a.record.fileId);
  assert.deepEqual(contentEvents(), [sha('B\n')]);
});

test('[R7-01] a first look says nothing changed, also when the read comes back after another look', async () => {
  const held = heldRead();
  const made = await setup({ ...withoutWatcher, io: held.io });
  const record = await made.service.registerEntry(made.workspace.workspaceId, entryIdOf('notes/a.md'));
  const events = [];
  await made.service.subscribeWorkspace(made.workspace.workspaceId, (event) => events.push(event));
  const point = held.hold('bytes');
  const reading = made.service.readText(record.fileId);
  await point.reached;
  await made.service.reconcile(record.fileId);
  point.release();
  await reading;
  assert.deepEqual(events.filter((e) => e.change === 'content'), []);
  assert.equal((await made.service.resourceRecord(record.fileId)).revision, sha('FIRST_TEXT_B3\n'));
});

test('[R7-01] a file trashed while a read is under way stays lost: what the read found is not put on its record', async () => {
  const { service, at, hold, a, contentEvents, revisionNow } = await opened();
  fs.writeFileSync(at('notes/a.md'), 'B\n');
  const point = hold('bytes');
  const reading = service.readText(a.record.fileId);
  await point.reached;
  await service.trashFile(a.record.fileId, 'op-trash');
  point.release();
  await reading;
  assert.equal((await service.resourceRecord(a.record.fileId)).status, 'missing');
  assert.equal(await revisionNow(), sha('FIRST_TEXT_B3\n'));
  assert.deepEqual(contentEvents(), []);
});

test('[R7-01] a file moved while a read is under way: what is at its new place is what its record comes to say, not the old path\'s', async () => {
  const { service, at, hold, a, notes, contentEvents, revisionNow } = await opened();
  fs.writeFileSync(at('notes/a.md'), 'B\n');
  const point = hold('bytes');
  const reading = service.readText(a.record.fileId);
  await point.reached;
  await service.moveFile(a.record.fileId, notes, 'moved.md', 'op-move');
  fs.writeFileSync(at('notes/a.md'), 'A_NEW_FILE_AT_THE_OLD_NAME\n');
  point.release();
  await reading;
  assert.equal((await service.resourceRecord(a.record.fileId)).relativePath, 'notes/moved.md');
  assert.equal(await revisionNow(), sha('B\n'));
  assert.deepEqual(contentEvents(), [sha('B\n')]);
});

test('[R7-01] a folder moved while a read is under way: the record follows the folder, and the look is at the new place', async () => {
  const { service, workspace, at, hold, a, notes, papers, revisionNow } = await opened();
  fs.writeFileSync(at('notes/a.md'), 'B\n');
  const point = hold('bytes');
  const reading = service.readText(a.record.fileId);
  await point.reached;
  await service.moveFolder(workspace.workspaceId, notes, papers, 'moved', 'op-folder');
  point.release();
  await reading;
  assert.equal((await service.resourceRecord(a.record.fileId)).relativePath, 'papers/moved/a.md');
  assert.equal(await revisionNow(), sha('B\n'));
  await pause(0);
});
