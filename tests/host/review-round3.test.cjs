// What the third review found in the workspace's own records (its R3
// numbers are kept in the test names): two creations of one name on a
// volume without hard links, a late look at the disk that took a new
// file's identity for an old one, notes of the recovery area that could
// not be read for a moment and were taken for no notes, a put-back
// finished at start that nobody heard of, and an earlier version read whole
// before it was found too large. Every case runs on a real temp folder;
// nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, errno, journalOf, registryOf, journalLine, entryIdOf } = require('./helpers/workspace-fixture.cjs');

const setup = fixture(test, 'round3');
const soon = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
/** The live records a registry on disk holds for a path: there must never be more than one. */
const liveAt = (project, relativePath) => registryOf(project).resources.filter((e) => e.record.relativePath === relativePath && e.record.status !== 'missing' && e.record.status !== 'ambiguous').map((e) => e.record.fileId);
const trashOf = (project) => path.join(project, '.thoughtdag', 'recovery', 'trash');
const provenance = { source: 'other', note: 'a synthetic page' };

/** A gate inside file-system calls: the first call that `matches` waits at `when` ('before' or 'after' the real call) until it is let through. */
function heldAt(method, matches, when = 'before', base = fs.promises) {
  let letThrough = () => {};
  let arrived = () => {};
  const reached = new Promise((resolve) => { arrived = resolve; });
  let first = true;
  const io = {
    ...base,
    [method]: async (...args) => {
      const mine = first && matches(...args);
      if (mine) first = false;
      const wait = () => new Promise((resolve) => { letThrough = resolve; arrived(); });
      if (mine && when === 'before') await wait();
      const result = await base[method](...args);
      if (mine && when === 'after') await wait();
      return result;
    },
  };
  return { io, reached, release: () => letThrough() };
}

/** Make the next read of a file that `matches` fail once with `code`, through fs.promises itself (what the code under test reads with). */
function failOnce(matches, code = 'EIO') {
  const real = fs.promises.readFile;
  let failed = 0;
  fs.promises.readFile = async (file, ...rest) => {
    if (failed === 0 && matches(String(file))) { failed++; throw errno(code); }
    return real(file, ...rest);
  };
  return { restore: () => { fs.promises.readFile = real; }, failed: () => failed };
}
const isTrashNote = (file) => file.includes(`${path.sep}trash${path.sep}`) && file.endsWith('.json');

// ── R3-01: two creations of one name where the volume has no hard links ─

const noHardLinks = { ...fs.promises, link: async () => { throw errno('ENOTSUP'); } };

for (const [how, make] of [
  ['imports', (service, request, notes, key, text) => service.importText(request(key, { parentId: notes }), { text, name: 'same', provenance })],
  ['empty creations', (service, request, notes, key) => service.createFile(request(key, { parentId: notes }))],
]) {
  test(`[R3-01] on a volume without hard links, two ${how} under one name at once each get a file of their own`, async () => {
    const created = how === 'imports' ? 'same.md' : 'Untitled-001.md';
    const held = heldAt('rename', (from, to) => String(from).includes('.new.tdag-create-') && String(to).endsWith(`${path.sep}${created}`), 'before', noHardLinks);
    const { service, start, request, at, project, notes } = await setup({ io: held.io });
    const a = make(service, request, notes, 'op-A', 'TEXT_OF_A_R301\n');
    await held.reached; // A found the name free and is about to take it
    const b = make(service, request, notes, 'op-B', 'TEXT_OF_B_R301\n');
    await Promise.race([b, soon()]);
    held.release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.notEqual(ra.relativePath, rb.relativePath, 'two files, at two names');
    if (how === 'imports') {
      assert.equal(fs.readFileSync(at(ra.relativePath), 'utf8'), 'TEXT_OF_A_R301\n');
      assert.equal(fs.readFileSync(at(rb.relativePath), 'utf8'), 'TEXT_OF_B_R301\n');
    }
    for (const r of [ra, rb]) {
      assert.equal((await service.resourceRecord(r.fileId)).status, 'ready');
      assert.deepEqual(liveAt(project, r.relativePath), [r.fileId]);
    }
    const restarted = start({ io: fs.promises });
    for (const r of [ra, rb]) assert.equal((await restarted.resourceRecord(r.fileId)).status, 'ready');
  });
}

test('[R3-01] on a volume without hard links, a file moved to the name a creation is taking does not take it, and is not overwritten', async () => {
  const held = heldAt('rename', (from, to) => String(from).includes('.new.tdag-create-') && String(to).endsWith(`${path.sep}same.md`), 'before', noHardLinks);
  const { service, request, at, open, notes } = await setup({ io: held.io });
  const keep = await open('papers/keep.md');
  const creating = service.importText(request('op-A', { parentId: notes }), { text: 'TEXT_OF_A_R301\n', name: 'same', provenance });
  await held.reached;
  const moving = service.moveFile(keep.record.fileId, notes, 'same.md', 'op-move');
  await Promise.race([moving, soon()]);
  held.release();
  const created = await creating;
  const moved = await moving.then((r) => r, (e) => e);
  assert.equal(fs.readFileSync(at('notes/same.md'), 'utf8'), 'TEXT_OF_A_R301\n');
  assert.equal(created.relativePath, 'notes/same.md');
  assert.equal(moved.code, 'exists', 'the move is refused: the name was taken');
  assert.equal(fs.readFileSync(at('papers/keep.md'), 'utf8'), 'KEEP_TEXT_C4\n', 'and the file that was to move is where it was, as it was');
  assert.equal((await service.resourceRecord(keep.record.fileId)).relativePath, 'papers/keep.md');
});

// ── R3-02: a late look at the disk and the new file at a lost file's name ─

test('[R3-02] a lost file is not found again in a new file that took its name while it was being looked for', async () => {
  const atName = (p) => String(p).endsWith(`${path.sep}notes${path.sep}a.md`);
  const linked = heldAt('link', (_from, to) => atName(to), 'after');
  const looked = heldAt('open', (file, flags) => flags === 'r' && atName(file), 'before');
  const { service, start, request, at, project, open, notes, papers } = await setup({ io: { ...fs.promises, link: linked.io.link, open: looked.io.open } });
  const old = await open('notes/a.md');
  await service.trashFile(old.record.fileId, 'op-trash');

  // a new file with the same name and the same words: it has its name, and no record yet
  const importing = service.importText(request('op-new', { parentId: notes }), { text: 'FIRST_TEXT_B3\n', name: 'a', provenance });
  await linked.reached;
  // the old file is looked for: nobody holds the path yet, and its content is being read
  const looking = service.reconcile(old.record.fileId);
  await looked.reached;
  linked.release();
  const fresh = await importing;
  looked.release();
  await looking;

  assert.equal((await service.resourceRecord(fresh.fileId)).status, 'ready', 'the new file keeps its identity');
  assert.equal((await service.resourceRecord(old.record.fileId)).status, 'missing', 'the old one stays lost');
  assert.deepEqual(liveAt(project, 'notes/a.md'), [fresh.fileId]);
  // nothing done through the old reference reaches the new file
  await assert.rejects(service.readText(old.record.fileId), { code: 'lost' });
  assert.notEqual((await service.saveText(old.record.fileId, old.revision, 'WRITTEN THROUGH OLD ID\n', 'op-save-old')).status, 'saved');
  await assert.rejects(service.moveFile(old.record.fileId, papers, 'stolen.md', 'op-move-old'), { code: 'lost' });
  await assert.rejects(service.trashFile(old.record.fileId, 'op-trash-old'), { code: 'lost' });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal((await service.readText(fresh.fileId)).text, 'FIRST_TEXT_B3\n');

  const restarted = start({ io: fs.promises });
  await restarted.rescanWorkspace((await restarted.resourceRecord(fresh.fileId)).workspaceId);
  assert.equal((await restarted.resourceRecord(fresh.fileId)).status, 'ready');
  assert.equal((await restarted.resourceRecord(old.record.fileId)).status, 'missing');
});

// ── R3-04: a copy's notes of its recovery area, read through a hiccup ──

for (const kind of ['file', 'folder']) {
  test(`[R3-04] a copy whose note of a trashed ${kind} cannot be read for a moment is not given its own identity half way`, async () => {
    const { service, start, project, base, choose, open, workspace, notes } = await setup();
    const original = await open('notes/a.md');
    if (kind === 'file') await service.trashFile(original.record.fileId, 'op-trash');
    else await service.trashFolder(workspace.workspaceId, notes, 'op-trash');
    const copyDir = path.join(base, `copy-note-eio-${kind}`);
    fs.cpSync(project, copyDir, { recursive: true });
    const identity = path.join(copyDir, '.thoughtdag', 'workspace.json');
    const before = fs.readFileSync(identity, 'utf8');

    const cut = start();
    const hiccup = failOnce(isTrashNote);
    try {
      await assert.rejects(choose(copyDir, cut), 'the copy is not opened as if its recovery area were done');
    } finally { hiccup.restore(); }
    assert.equal(hiccup.failed(), 1);
    assert.equal(fs.readFileSync(identity, 'utf8'), before, 'the folder does not yet carry an id of its own');
    assert.ok(fs.existsSync(path.join(copyDir, '.thoughtdag', 'identity-of-copy.json')), 'the plan of new ids is kept for the next try');
    const firstTry = registryOf(copyDir).resources.find((e) => e.record.relativePath === 'notes/a.md').record.fileId;

    const copy = await choose(copyDir, cut);
    assert.notEqual(copy.workspaceId, workspace.workspaceId);
    const copyId = registryOf(copyDir).resources.find((e) => e.record.relativePath === 'notes/a.md').record.fileId;
    assert.equal(copyId, firstTry, 'the ids of the first try are the ones that stand');
    const [item] = await cut.listRecovery(copy.workspaceId);
    if (kind === 'file') assert.equal(item.fileId, copyId);
    await cut.restoreFromRecovery(copy.workspaceId, item.receiptId, 'op-restore-copy');
    assert.equal((await cut.resourceRecord(copyId)).status, 'ready');
    assert.equal((await cut.readText(copyId)).text, 'FIRST_TEXT_B3\n');
    // the original is untouched
    assert.equal((await cut.resourceRecord(original.record.fileId)).status, 'missing');
    assert.equal(fs.existsSync(path.join(project, 'notes', 'a.md')), false);
  });
}

// ── R3-05 / R3-06: a put-back finished at start ────────────────────────

/** A workspace whose `notes/a.md` (as itself, or inside its trashed folder) was being put back when the process ended: it is back in its place, and its record is still lost. */
async function cutShortPutBack(kind) {
  const made = await setup();
  const a = await made.open('notes/a.md');
  let item;
  if (kind === 'file') {
    await made.service.trashFile(a.record.fileId, 'op-trash');
    [item] = await made.service.listRecovery(made.workspace.workspaceId);
    fs.appendFileSync(journalOf(made.project), journalLine({ opId: 'op-restore', kind: 'restore', phase: 'intent', receiptId: item.receiptId, to: 'notes/a.md', itemKind: 'file' }));
    fs.renameSync(path.join(trashOf(made.project), item.receiptId, 'a.md'), made.at('notes/a.md'));
  } else {
    item = await made.service.trashFolder(made.workspace.workspaceId, made.notes, 'op-trash');
    fs.appendFileSync(journalOf(made.project), journalLine({ opId: 'op-restore', kind: 'restore', phase: 'intent', receiptId: item.receiptId, to: 'notes', itemKind: 'folder' }));
    fs.renameSync(path.join(trashOf(made.project), item.receiptId, 'notes'), made.at('notes'));
  }
  const note = path.join(trashOf(made.project), `${item.receiptId}.json`);
  return { ...made, a, item, note };
}

for (const kind of ['file', 'folder']) {
  test(`[R3-05] a ${kind}'s put-back whose note cannot be read for a moment at start is not taken as done, and is finished the next time`, async () => {
    const { start, workspace, a, item, note, project } = await cutShortPutBack(kind);
    const hiccup = failOnce((file) => file === note);
    let restarted;
    try {
      restarted = start();
      // the first use settles what the crash left (no look at the disk follows, which would find the file by its words)
      assert.deepEqual(await restarted.listRecovery(workspace.workspaceId), []);
    } finally { hiccup.restore(); }
    assert.equal(hiccup.failed(), 1);
    assert.ok(fs.existsSync(note), 'the note that names the files is kept');
    assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'missing', 'nothing is claimed back that was not');
    assert.ok(!JSON.parse(`[${fs.readFileSync(journalOf(project), 'utf8').trim().split('\n').join(',')}]`).some((e) => e.opId === 'op-restore' && (e.phase === 'done' || e.phase === 'failed')), 'and the put-back is neither done nor given up');

    // the next try (the person's, with the same operation) finishes it with the file's own identity
    assert.equal(await restarted.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), entryIdOf(kind === 'file' ? 'notes/a.md' : 'notes'));
    assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'ready');
    assert.equal((await restarted.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
    assert.equal(fs.existsSync(note), false, 'the note goes only after');
    assert.deepEqual(await restarted.listRecovery(workspace.workspaceId), []);
  });

  test(`[R3-05] a ${kind}'s put-back whose note could not be read at start is finished by the next start`, async () => {
    const { start, workspace, a, note } = await cutShortPutBack(kind);
    const hiccup = failOnce((file) => file === note);
    try { await start().listRecovery(workspace.workspaceId); } finally { hiccup.restore(); }
    assert.equal(hiccup.failed(), 1);
    const again = start();
    await again.listRecovery(workspace.workspaceId);
    assert.equal((await again.resourceRecord(a.record.fileId)).status, 'ready');
    assert.equal((await again.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
    assert.equal(fs.existsSync(note), false);
  });

  test(`[R3-06] a ${kind}'s put-back finished at start is heard of by whoever was listening, once`, async () => {
    const { start, workspace, a } = await cutShortPutBack(kind);
    const restarted = start();
    const heard = [];
    await restarted.subscribeWorkspace(workspace.workspaceId, (event) => heard.push([event.change, event.fileId, event.opId]));
    assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'missing', 'what the listener saw first');
    await restarted.rescanWorkspace(workspace.workspaceId);
    assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'ready');
    assert.deepEqual(heard, [['restored', a.record.fileId, 'op-restore']]);
    await restarted.rescanWorkspace(workspace.workspaceId);
    await restarted.restoreFromRecovery(workspace.workspaceId, 'whatever', 'op-restore');
    assert.deepEqual(heard, [['restored', a.record.fileId, 'op-restore']], 'and not again');
  });
}

// ── R3-15: an earlier version too large to read is not read ────────────

test('[R3-15] an earlier version above the limit is refused from its size, without its content being read', async () => {
  let read = 0;
  const counting = {
    ...fs.promises,
    readFile: async (...args) => { const out = await fs.promises.readFile(...args); if (String(args[0]).includes(`${path.sep}versions${path.sep}`)) read += out.length; return out; },
    open: async (...args) => {
      const handle = await fs.promises.open(...args);
      if (!String(args[0]).includes(`${path.sep}versions${path.sep}`)) return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'readFile') return async (...a) => { const out = await target.readFile(...a); read += out.length; return out; };
          if (key === 'read') return async (...a) => { const out = await target.read(...a); read += out.bytesRead; return out; };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
  const { service, open } = await setup({ io: counting });
  const a = await open('notes/a.md');
  const big = 'x'.repeat(9 * 1024 * 1024);
  const first = await service.saveText(a.record.fileId, a.revision, big, 'op-big');
  assert.equal(first.status, 'saved');
  const second = await service.saveText(a.record.fileId, first.revision, 'small again\n', 'op-small');
  assert.equal(second.status, 'saved');
  const versions = await service.listVersions(a.record.fileId);
  const large = versions.find((v) => v.size === Buffer.byteLength(big));
  assert.ok(large, 'the large version is kept');
  read = 0;
  await assert.rejects(service.readVersion(a.record.fileId, large.revision), { code: 'too-large' });
  assert.ok(read < 1024 * 1024, `the version's content is not read (read ${read} bytes)`);
  // a version within the limit still reads as it was, and its hash is checked
  const small = versions.find((v) => v.size === Buffer.byteLength('FIRST_TEXT_B3\n'));
  assert.equal((await service.readVersion(a.record.fileId, small.revision)).text, 'FIRST_TEXT_B3\n');
});
