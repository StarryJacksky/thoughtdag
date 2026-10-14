// What the second review found in the workspace's own records (its R2
// numbers are kept in the test names): an identity that came back onto
// another file, two identities for one file, a creation that took someone
// else's file for its own, a journal line lost after a write that failed,
// a put-back that a crash left half done, and a copied workspace whose
// recovery area still spoke of the original's files. Every case runs on a
// real temp folder; nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, errno, journalOf, registryOf, journalLine, leftovers, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { createJournal } = require('../../runtime/workspace/journal.cjs');

const setup = fixture(test, 'round2');
const soon = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
/** The live records a registry on disk holds for a path: there must never be more than one. */
const liveAt = (project, relativePath) => registryOf(project).resources.filter((e) => e.record.relativePath === relativePath && e.record.status !== 'missing' && e.record.status !== 'ambiguous').map((e) => e.record.fileId);
const trashOf = (project) => path.join(project, '.thoughtdag', 'recovery', 'trash');

/** A gate inside file-system calls: the first call that `matches` waits at `when` ('before' or 'after' the real call) until it is let through. */
function heldAt(method, matches, when = 'before') {
  let letThrough = () => {};
  let arrived = () => {};
  const reached = new Promise((resolve) => { arrived = resolve; });
  let first = true;
  const io = {
    ...fs.promises,
    [method]: async (...args) => {
      const mine = first && matches(...args);
      if (mine) first = false;
      const wait = () => new Promise((resolve) => { letThrough = resolve; arrived(); });
      if (mine && when === 'before') await wait();
      const result = await fs.promises[method](...args);
      if (mine && when === 'after') await wait();
      return result;
    },
  };
  return { io, reached, release: () => letThrough() };
}

// ── R2-01: a lost identity and the new file that took its name ─────────

for (const [how, takeTheName] of [
  ['imported', async ({ service, request, notes }) => service.importText(request('op-again', { parentId: notes }), { text: 'FIRST_TEXT_B3\n', name: 'a', provenance: { source: 'other', note: 'a synthetic page' } })],
  ['copied', async ({ service, at, workspace, notes }) => {
    fs.writeFileSync(at('papers/same.md'), 'FIRST_TEXT_B3\n');
    const same = await service.registerEntry(workspace.workspaceId, entryIdOf('papers/same.md'));
    return service.copyFile(same.fileId, notes, 'a.md', 'op-again');
  }],
]) {
  test(`[R2-01] a trashed file does not come back as the file that was ${how} under its name and says the same`, async () => {
    const made = await setup();
    const { service, start, open, at, workspace, archive } = { ...made, archive: entryIdOf('papers') };
    const old = await open('notes/a.md');
    await service.trashFile(old.record.fileId, 'op-trash');
    const taken = await takeTheName(made);
    assert.equal(taken.relativePath, 'notes/a.md');
    assert.notEqual(taken.fileId, old.record.fileId);

    await service.rescanWorkspace(workspace.workspaceId);
    assert.equal((await service.reconcile(old.record.fileId)).status, 'missing', 'the old reference stays lost');
    assert.deepEqual(liveAt(made.project, 'notes/a.md'), [taken.fileId]);

    // nothing done through the old reference reaches the new file
    await assert.rejects(service.readText(old.record.fileId), { code: 'lost' });
    assert.notEqual((await service.saveText(old.record.fileId, old.revision, 'WRITTEN_VIA_OLD_X9\n', 'op-save-old')).status, 'saved');
    await assert.rejects(service.moveFile(old.record.fileId, archive, 'stolen.md', 'op-move-old'), { code: 'lost' });
    await assert.rejects(service.trashFile(old.record.fileId, 'op-trash-old'), { code: 'lost' });
    assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');

    const restarted = start();
    await restarted.rescanWorkspace(workspace.workspaceId);
    assert.equal((await restarted.resourceRecord(old.record.fileId)).status, 'missing');
    assert.equal((await restarted.resourceRecord(taken.fileId)).status, 'ready');
    assert.deepEqual(liveAt(made.project, 'notes/a.md'), [taken.fileId]);
  });
}

// ── R2-02: a folder being moved and a file in it being registered ──────

test('[R2-02] a file asked for at its folder\'s new place while the folder is still being moved is the file it was', async () => {
  const held = heldAt('rename', (_from, to) => String(to).endsWith(`${path.sep}after`), 'after');
  const { service, start, workspace, open, project, notes } = await setup({ io: held.io });
  const a = await open('notes/a.md');
  const moving = service.moveFolder(workspace.workspaceId, notes, undefined, 'after', 'op-move');
  await held.reached; // the folder is under its new name; the records have not followed yet
  const registering = service.registerEntry(workspace.workspaceId, entryIdOf('after/a.md'));
  await Promise.race([registering, soon()]);
  held.release();
  await moving;
  assert.equal((await registering).fileId, a.record.fileId);
  assert.deepEqual(liveAt(project, 'after/a.md'), [a.record.fileId]);
  assert.equal((await start().resourceRecord(a.record.fileId)).relativePath, 'after/a.md');
  assert.deepEqual(liveAt(project, 'after/a.md'), [a.record.fileId], 'and a restart finds one identity');
});

test('[R2-02] after a crash in the middle of a folder move, the first thing asked being a file at the new place still gives the file it was', async () => {
  const { start, workspace, open, at, project } = await setup();
  const a = await open('notes/a.md');
  fs.appendFileSync(journalOf(project), journalLine({ opId: 'op-move', kind: 'move-folder', phase: 'intent', from: 'notes', to: 'after' }));
  fs.renameSync(at('notes'), at('after'));
  const restarted = start();
  const first = await restarted.registerEntry(workspace.workspaceId, entryIdOf('after/a.md'));
  assert.equal(first.fileId, a.record.fileId);
  assert.deepEqual(liveAt(project, 'after/a.md'), [a.record.fileId]);
  assert.equal((await restarted.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
});

test('[R2-02] a record that was given a second identity at a folder\'s new place loses it to the file that moved there', async () => {
  // a registry left by the interleaving above, as an earlier build could write it
  const { start, workspace, open, at, project } = await setup();
  const a = await open('notes/a.md');
  const doc = registryOf(project);
  const original = doc.resources.find((e) => e.record.fileId === a.record.fileId);
  doc.resources.push({ ...original, record: { ...original.record, fileId: 'file_second_identity', relativePath: 'after/a.md', locator: { ...original.record.locator, relativePath: 'after/a.md' } } });
  fs.writeFileSync(path.join(project, '.thoughtdag', 'resources.json'), JSON.stringify(doc, null, 2) + '\n');
  fs.appendFileSync(journalOf(project), journalLine({ opId: 'op-move', kind: 'move-folder', phase: 'intent', from: 'notes', to: 'after' }));
  fs.renameSync(at('notes'), at('after'));
  const restarted = start();
  assert.equal((await restarted.registerEntry(workspace.workspaceId, entryIdOf('after/a.md'))).fileId, a.record.fileId);
  assert.deepEqual(liveAt(project, 'after/a.md'), [a.record.fileId]);
});

// ── R2-07: whose file a creation finds at the name it was trying ───────

test('[R2-07] a creation cut short before it had the name does not take the file another creation made there for its own', async () => {
  // A stops just before it takes the name; B, a different request for the same kind of file, takes it and finishes
  const takingTheName = (target) => String(target).endsWith(`${path.sep}Untitled-001.md`);
  const held = heldAt('link', (_from, to) => takingTheName(to));
  const heldOpen = heldAt('open', (file, flags) => flags === 'wx' && takingTheName(file));
  const io = { ...fs.promises, link: held.io.link, open: heldOpen.io.open };
  const { service, start, request, at, notes } = await setup({ io });
  void service.createFile(request('op-A', { parentId: notes })).catch(() => {});
  await Promise.race([held.reached, heldOpen.reached]);
  const b = await service.createFile(request('op-B', { parentId: notes }));
  assert.equal(b.relativePath, 'notes/Untitled-001.md');
  // the process ends here: A never gets further

  const restarted = start({ io: fs.promises });
  const a = await restarted.createFile(request('op-A', { parentId: notes }));
  assert.notEqual(a.fileId, b.fileId, 'two requests, two files');
  assert.equal(a.relativePath, 'notes/Untitled-002.md');
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'Untitled-002.md', 'a.md']);
  assert.equal((await restarted.resourceRecord(b.fileId)).relativePath, 'notes/Untitled-001.md');
  assert.equal((await restarted.createFile(request('op-A', { parentId: notes }))).fileId, a.fileId);
  assert.deepEqual(leftovers(at('notes')), []);
});

test('[R2-07] a creation that found its first name taken and was cut short before the next takes neither file for its own', async () => {
  const { service, start, request, at, project, notes } = await setup();
  const b = await service.createFile(request('op-B', { parentId: notes }));
  // what A left: it meant to write the same empty file, tried the first name, and was about to try the second
  fs.appendFileSync(journalOf(project),
    journalLine({ opId: 'op-A', kind: 'create', phase: 'intent', parent: 'notes', extension: 'md', origin: 'workspace', recordOrigin: 'workspace', revision: sha('') })
    + journalLine({ opId: 'op-A', kind: 'create', phase: 'attempt', relativePath: 'notes/Untitled-001.md' })
    + journalLine({ opId: 'op-A', kind: 'create', phase: 'attempt', relativePath: 'notes/Untitled-002.md' }));
  // someone else's empty file is at the second name by the time the app is back
  fs.writeFileSync(at('notes/Untitled-002.md'), '');
  const a = await start().createFile(request('op-A', { parentId: notes }));
  assert.notEqual(a.fileId, b.fileId);
  assert.equal(a.relativePath, 'notes/Untitled-003.md');
});

// ── R2-08: the journal after a write that failed part-way ──────────────

test('[R2-08] what is noted after a note that failed part-way, by the same running app, is still there when the journal is read again', async () => {
  const { project } = await setup();
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  // the disk fills after the first bytes of the first line that is written
  const realOpen = fs.promises.open;
  let failed = false;
  fs.promises.open = async (file, ...rest) => {
    const handle = await realOpen(file, ...rest);
    if (failed || !String(file).endsWith('journal.jsonl')) return handle;
    failed = true;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'writeFile') return async (text) => { await target.writeFile(String(text).slice(0, 17)); throw errno('ENOSPC'); };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    const journal = createJournal({ rootPath: project });
    await assert.rejects(journal.append({ opId: 'op-first', kind: 'save', phase: 'intent', fileId: 'file_x', base: sha('a'), next: sha('b'), temp: '.x.tdag-save-00000000' }), { code: 'ENOSPC' });
    // space is freed and the app goes on without a restart
    await journal.append({ opId: 'op-second', kind: 'save', phase: 'intent', fileId: 'file_x', base: sha('a'), next: sha('c'), temp: '.x.tdag-save-11111111' });
    assert.deepEqual((await journal.pending()).map((op) => op.opId), ['op-second']);
    assert.deepEqual((await createJournal({ rootPath: project }).pending()).map((op) => op.opId), ['op-second'], 'the line that landed is whole and found again');
    await journal.append({ opId: 'op-second', kind: 'save', phase: 'done', fileId: 'file_x', revision: sha('c') });
    assert.equal((await createJournal({ rootPath: project }).completed('op-second'))?.revision, sha('c'));
  } finally {
    fs.promises.open = realOpen;
  }
});

// ── R2-09: a put-back that a crash left half done ──────────────────────

/** A workspace with a.md in its recovery area, and what a restore of it would have noted before it was cut short. */
async function trashedFile() {
  const made = await setup();
  const a = await made.open('notes/a.md');
  await made.service.trashFile(a.record.fileId, 'op-trash');
  const [item] = await made.service.listRecovery(made.workspace.workspaceId);
  const kept = path.join(trashOf(made.project), item.receiptId, 'a.md');
  fs.appendFileSync(journalOf(made.project), journalLine({ opId: 'op-restore', kind: 'restore', phase: 'intent', receiptId: item.receiptId, to: 'notes/a.md', itemKind: 'file' }));
  return { ...made, a, item, kept };
}
async function backAsItself({ start, workspace, a, item, at, project }) {
  const restarted = start();
  assert.equal(await restarted.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), entryIdOf('notes/a.md'));
  assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'ready', 'the file that came back is the file it was');
  assert.equal((await restarted.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(await restarted.listRecovery(workspace.workspaceId), []);
  assert.deepEqual(liveAt(project, 'notes/a.md'), [a.record.fileId]);
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal(fs.statSync(at('notes/a.md')).nlink, 1, 'it is under one name');
}

test('[R2-09] a put-back cut short after the file was back and before its record was is finished on the next start', async () => {
  const made = await trashedFile();
  fs.renameSync(made.kept, made.at('notes/a.md'));
  await backAsItself(made);
});

test('[R2-09] a put-back cut short while the file was under both names is finished on the next start', async () => {
  const made = await trashedFile();
  fs.linkSync(made.kept, made.at('notes/a.md'));
  await backAsItself(made);
});

test('[R2-09] a put-back cut short after its record was updated and before its receipt was cleared is finished on the next start', async () => {
  const made = await trashedFile();
  fs.renameSync(made.kept, made.at('notes/a.md'));
  const doc = registryOf(made.project);
  doc.resources.find((e) => e.record.fileId === made.a.record.fileId).record.status = 'ready';
  fs.writeFileSync(path.join(made.project, '.thoughtdag', 'resources.json'), JSON.stringify(doc, null, 2) + '\n');
  await backAsItself(made);
});

test('[R2-09] a folder\'s put-back cut short after the folder was back gives every file in it its identity again', async () => {
  const { service, start, workspace, open, at, project, notes } = await setup();
  const a = await open('notes/a.md');
  const item = await service.trashFolder(workspace.workspaceId, notes, 'op-trash');
  fs.appendFileSync(journalOf(project), journalLine({ opId: 'op-restore', kind: 'restore', phase: 'intent', receiptId: item.receiptId, to: 'notes', itemKind: 'folder' }));
  fs.renameSync(path.join(trashOf(project), item.receiptId, 'notes'), at('notes'));
  const restarted = start();
  assert.equal(await restarted.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), entryIdOf('notes'));
  assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'ready');
  assert.equal((await restarted.readText(a.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(await restarted.listRecovery(workspace.workspaceId), []);
});

// ── R2-10: the recovery area of a copied workspace ─────────────────────

test('[R2-10] a copy of a workspace with a trashed file puts that file back as the copy\'s own', async () => {
  const { service, start, workspace, project, base, choose, open } = await setup();
  const original = await open('notes/a.md');
  await service.trashFile(original.record.fileId, 'op-trash');
  const copyDir = path.join(base, 'copy-with-trash');
  fs.cpSync(project, copyDir, { recursive: true });
  const copy = await choose(copyDir);
  assert.notEqual(copy.workspaceId, workspace.workspaceId);
  const copyId = registryOf(copyDir).resources.find((e) => e.record.relativePath === 'notes/a.md').record.fileId;
  assert.notEqual(copyId, original.record.fileId);

  const [item] = await service.listRecovery(copy.workspaceId);
  assert.equal(item.fileId, copyId, 'what the copy\'s recovery area holds is the copy\'s file');
  const heard = [];
  await service.subscribeWorkspace(copy.workspaceId, (event) => heard.push([event.change, event.fileId]));
  await service.restoreFromRecovery(copy.workspaceId, item.receiptId, 'op-restore-copy');
  assert.equal((await service.resourceRecord(copyId)).status, 'ready');
  assert.equal((await service.readText(copyId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(heard, [['restored', copyId]]);
  // the original is as it was: its file is still in its own recovery area
  assert.equal((await service.resourceRecord(original.record.fileId)).status, 'missing');
  assert.equal((await service.listRecovery(workspace.workspaceId))[0].fileId, original.record.fileId);
  assert.equal(fs.existsSync(path.join(project, 'notes', 'a.md')), false);
  assert.equal((await start().resourceRecord(copyId)).status, 'ready');
});

test('[R2-10] a copy of a workspace with a trashed folder puts the folder back with the copy\'s own files in it', async () => {
  const { service, workspace, project, base, choose, open, notes } = await setup();
  const original = await open('notes/a.md');
  await service.trashFolder(workspace.workspaceId, notes, 'op-trash');
  const copyDir = path.join(base, 'copy-with-trashed-folder');
  fs.cpSync(project, copyDir, { recursive: true });
  const copy = await choose(copyDir);
  const copyId = registryOf(copyDir).resources.find((e) => e.record.relativePath === 'notes/a.md').record.fileId;
  assert.notEqual(copyId, original.record.fileId);
  const [item] = await service.listRecovery(copy.workspaceId);
  const heard = [];
  await service.subscribeWorkspace(copy.workspaceId, (event) => heard.push([event.change, event.fileId]));
  await service.restoreFromRecovery(copy.workspaceId, item.receiptId, 'op-restore-copy');
  assert.equal((await service.resourceRecord(copyId)).status, 'ready');
  assert.equal((await service.readText(copyId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(heard, [['restored', copyId]]);
  assert.equal((await service.resourceRecord(original.record.fileId)).status, 'missing');
});

test('[R2-10] giving a copy its own identity, cut short part-way, is finished with the same new identities the next time it is opened', async () => {
  const { service, start, project, base, choose, open } = await setup();
  const original = await open('notes/a.md');
  await service.trashFile(original.record.fileId, 'op-trash');
  const copyDir = path.join(base, 'copy-cut-short');
  fs.cpSync(project, copyDir, { recursive: true });
  // the first try gets as far as rewriting the registry, and stops before the folder is given its own id
  const cut = start();
  const original_ = path.join(copyDir, '.thoughtdag', 'workspace.json');
  const before = fs.readFileSync(original_, 'utf8');
  const realRename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    if (String(to) === original_) throw errno('EIO');
    return realRename(from, to);
  };
  try {
    await assert.rejects(choose(copyDir, cut));
  } finally {
    fs.promises.rename = realRename;
  }
  assert.equal(fs.readFileSync(original_, 'utf8'), before, 'the folder still carries the original\'s id');
  const firstTry = registryOf(copyDir).resources.find((e) => e.record.relativePath === 'notes/a.md').record.fileId;
  assert.notEqual(firstTry, original.record.fileId);

  const copy = await choose(copyDir, cut);
  const copyId = registryOf(copyDir).resources.find((e) => e.record.relativePath === 'notes/a.md').record.fileId;
  assert.equal(copyId, firstTry, 'the identities the first try gave are the ones that stand');
  const [item] = await cut.listRecovery(copy.workspaceId);
  assert.equal(item.fileId, copyId);
  await cut.restoreFromRecovery(copy.workspaceId, item.receiptId, 'op-restore-copy');
  assert.equal((await cut.resourceRecord(copyId)).status, 'ready');
});
