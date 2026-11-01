// What the review of the file operations found (its R4 numbers are kept in the
// test names; the report itself was never written to disk, so each case here
// is built from the one line later reports carry of it): a copy and a create
// reaching for one name, a name published before its identity is registered,
// a move and a tool's output meeting at the old name, a put-back that takes a
// failing disk for a missing file or loses what it was to announce, and parts
// of a large text cut short or cut inside a character. On real temp folders,
// with faults and pauses under the file-system calls; nothing here touches a
// real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, entryIdOf, registryOf } = require('./helpers/workspace-fixture.cjs');

const setup = fixture(test, 'review-r4');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errno = (code) => Object.assign(new Error(`${code}: injected`), { code });
/** Start something at a chosen moment without making that moment wait on it for good: what is held apart waits, and the moment goes on. */
const alongside = async (start) => { const run = start(); run.catch(() => {}); await Promise.race([run.then(() => {}, () => {}), pause(80)]); return { run }; };
const withoutWatcher = { watch: { watchFn: () => ({ close: () => {}, on: () => {} }), quietMs: 3600_000 } };
const liveAt = (project, rel) => registryOf(project).resources.filter((r) => (r.record ?? r).relativePath === rel && (r.record ?? r).status !== 'missing');

/** File-system calls with one call replaced; the rest are the real ones. */
const ioWith = (more) => ({ ...fs.promises, ...more });

test('[R4-01] a copy to a name that a creation is taking on a volume without hard links is not overwritten by it', async () => {
  let hook = null;
  const io = ioWith({
    link: async () => { throw errno('EPERM'); },
    stat: async (file, ...rest) => {
      const answer = fs.promises.stat(file, ...rest);
      await answer.catch(() => {});
      // the creation has looked and found the name free: a copy to that name comes now
      if (hook && String(file).endsWith('taken.md')) { const run = hook; hook = null; await run(); }
      return answer;
    },
  });
  const { service, open, at, notes, request } = await setup({ io });
  const a = await open('notes/a.md');
  let copied = null;
  hook = async () => { copied = await alongside(() => service.copyFile(a.record.fileId, notes, 'taken.md', 'op-copy')); };
  const created = await service.importText(request('op-create', { parentId: notes }), { text: 'CREATED_TEXT\n', name: 'taken', provenance: { source: 'other' } });
  const copy = await copied.run.then((r) => ({ ok: r }), (e) => ({ err: e }));
  // one of them has the name, and what is there is what that one says it wrote
  assert.equal(copy.err?.code, 'exists', 'the copy finds the name taken: it did not write under a creation that then replaced it');
  assert.equal(fs.readFileSync(at('notes/taken.md'), 'utf8'), 'CREATED_TEXT\n');
  assert.equal(created.revision, sha('CREATED_TEXT\n'));
});

test('[R4-02] a look at a file a creation has just published finds the creation\'s identity, not one of its own', async () => {
  let hook = null;
  const io = ioWith({
    unlink: async (file) => {
      const answer = await fs.promises.unlink(file);
      // the name is there now; the identity is not registered yet
      if (hook && String(file).includes('.new.tdag-create-')) { const run = hook; hook = null; await run(); }
      return answer;
    },
  });
  const { service, workspace, project, notes, request } = await setup({ io });
  let looked = null;
  hook = async () => { looked = await alongside(() => service.registerEntry(workspace.workspaceId, entryIdOf('notes/fresh.md'))); };
  const created = await service.importText(request('op-create', { parentId: notes }), { text: 'FRESH\n', name: 'fresh', provenance: { source: 'other' } });
  const seen = await looked.run;
  assert.equal(seen.fileId, created.fileId, 'one file, one identity');
  assert.equal((await service.resourceRecord(seen.fileId)).status, 'ready', 'whoever looked is not left holding a lost record');
  assert.equal(liveAt(project, 'notes/fresh.md').length, 1);
});

test('[R4-02] a look at a copy that has just been made finds the copy\'s identity', async () => {
  let hook = null;
  const io = ioWith({
    copyFile: async (...args) => {
      const answer = await fs.promises.copyFile(...args);
      if (hook) { const run = hook; hook = null; await run(); }
      return answer;
    },
  });
  const { service, workspace, open, notes } = await setup({ io });
  const a = await open('notes/a.md');
  let looked = null;
  hook = async () => { looked = await alongside(() => service.registerEntry(workspace.workspaceId, entryIdOf('notes/copy.md'))); };
  const copy = await service.copyFile(a.record.fileId, notes, 'copy.md', 'op-copy');
  const seen = await looked.run;
  assert.equal(seen.fileId, copy.fileId);
  assert.equal((await service.resourceRecord(seen.fileId)).status, 'ready');
});

test('[R4-03] what a tool puts at a file\'s old name while the file is being moved away is kept, and is a file of its own', async () => {
  let hook = null;
  const io = ioWith({
    unlink: async (file) => {
      // the file has its new name and still has its old one: a tool's output lands on the old name now
      if (hook && String(file).endsWith('notes/a.md')) { const run = hook; hook = null; await run(); }
      return fs.promises.unlink(file);
    },
  });
  const { service, open, at, notes } = await setup({ io });
  const a = await open('notes/a.md');
  fs.writeFileSync(at('notes/source.tex'), 'SOURCE\n');
  const source = await open('notes/source.tex');
  let put = null;
  hook = async () => { put = await alongside(() => service.putBeside(source.record.fileId, 'a.md', Buffer.from('MADE_BY_THE_TOOL\n'))); };
  const moved = await service.moveFile(a.record.fileId, notes, 'b.md', 'op-move');
  const made = await put.run;
  assert.equal(fs.readFileSync(at('notes/b.md'), 'utf8'), 'FIRST_TEXT_B3\n', 'the moved file keeps what it held');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'MADE_BY_THE_TOOL\n', 'the tool\'s output is not taken away with the old name');
  assert.equal(moved.relativePath, 'notes/b.md');
  assert.equal((await service.resourceRecord(a.record.fileId)).revision, sha('FIRST_TEXT_B3\n'), 'the moved file\'s record says what the moved file holds');
  assert.notEqual(made.fileId, a.record.fileId, 'the output is a file of its own');
  assert.equal(made.revision, sha('MADE_BY_THE_TOOL\n'));
});

test('[R4-03] a move and a move the other way between two names do not wait on each other for ever', async () => {
  const { service, open, notes } = await setup();
  const a = await open('notes/a.md');
  const keep = await open('papers/keep.md');
  const settled = await Promise.race([
    Promise.allSettled([service.moveFile(a.record.fileId, notes, 'x.md', 'op-1'), service.moveFile(keep.record.fileId, notes, 'a.md', 'op-2')]),
    pause(5000).then(() => 'stuck'),
  ]);
  assert.notEqual(settled, 'stuck');
});

/** A workspace that keeps what is trashed in its own recovery area, with `notes/` trashed. */
const failNow = { on: false };
async function trashed(faults) {
  const made = await setup({ ...withoutWatcher, io: ioWith(faults) });
  const a = await made.open('notes/a.md');
  await made.service.trashFolder(made.workspace.workspaceId, made.notes, 'op-trash');
  const [item] = await made.service.listRecovery(made.workspace.workspaceId);
  const events = [];
  await made.service.subscribeWorkspace(made.workspace.workspaceId, (event) => events.push(event));
  return { ...made, a, item, events };
}

test('[R4-04] a put-back that cannot look at a file it brought back is not over: it does not leave the file lost for good', async () => {
  let fail = false;
  const { service, workspace, at, a, item, events } = await trashed({
    stat: async (file, ...rest) => {
      if (fail && String(file).endsWith(path.join('notes', 'a.md'))) { fail = false; throw errno('EIO'); }
      return fs.promises.stat(file, ...rest);
    },
  });
  fail = true;
  await assert.rejects(service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), { code: 'EIO' });
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n', 'the folder is back on disk');
  // asked again, it finishes as it was begun: the file is found and said to be back
  assert.equal(await service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), entryIdOf('notes'));
  assert.equal((await service.resourceRecord(a.record.fileId)).status, 'ready');
  assert.deepEqual(events.map((e) => [e.fileId, e.change]), [[a.record.fileId, 'restored']]);
});

test('[R4-04] the same, settled the next time the workspace is opened', async () => {
  let fail = false;
  const { service, workspace, a, item, start } = await trashed({
    stat: async (file, ...rest) => {
      if (fail && String(file).endsWith(path.join('notes', 'a.md'))) { fail = false; throw errno('EIO'); }
      return fs.promises.stat(file, ...rest);
    },
  });
  fail = true;
  await assert.rejects(service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), { code: 'EIO' });
  const restarted = start({ io: fs.promises });
  await restarted.listRecovery(workspace.workspaceId);
  assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'ready');
});

// the journal takes no `io`: its one writer is faulted where it opens its file
function failJournal(matches, code) {
  const open = fs.promises.open;
  let left = 1;
  fs.promises.open = async function faulty(file, ...rest) {
    const handle = await open.call(this, file, ...rest);
    if (!String(file).endsWith('journal.jsonl')) return handle;
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async (text, ...more) => {
      if (left > 0 && matches(String(text))) { left--; throw errno(code); }
      return writeFile(text, ...more);
    };
    return handle;
  };
  return () => { fs.promises.open = open; };
}
const restoreDone = (text) => text.includes('"kind":"restore"') && text.includes('"phase":"done"');
const noteOf = (project, receiptId) => path.join(project, '.thoughtdag', 'recovery', 'trash', `${receiptId}.json`);

test('[R4-05] a put-back whose last note cannot be written has still happened: it says what came back, and its own note stays until it is settled', async () => {
  const { service, workspace, project, at, a, item, events, start } = await trashed({});
  const noted = noteOf(project, item.receiptId);
  assert.ok(fs.existsSync(noted), 'a trashed folder keeps a note of what it holds');
  const restore = failJournal(restoreDone, 'ENOSPC');
  let entry;
  try { entry = await service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'); } finally { restore(); }
  assert.equal(entry, entryIdOf('notes'));
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.deepEqual(events.map((e) => [e.fileId, e.change]), [[a.record.fileId, 'restored']], 'whoever shows the file hears it is back');
  assert.ok(fs.existsSync(noted), 'the note outlives the operation that is not yet noted as over');
  // the next start finds the operation unfinished, and finishes it
  const restarted = start({ io: fs.promises });
  await restarted.listRecovery(workspace.workspaceId);
  assert.equal(fs.existsSync(noted), false);
  assert.equal((await restarted.resourceRecord(a.record.fileId)).status, 'ready');
});

test('[R4-05] a put-back finished at start whose last note cannot be written tries again next time, knowing what it brought back', async () => {
  const { service, workspace, project, a, item, start } = await trashed({
    stat: async (file, ...rest) => {
      if (String(file).endsWith(path.join('notes', 'a.md')) && failNow.on) { failNow.on = false; throw errno('EIO'); }
      return fs.promises.stat(file, ...rest);
    },
  });
  failNow.on = true;
  await assert.rejects(service.restoreFromRecovery(workspace.workspaceId, item.receiptId, 'op-restore'), { code: 'EIO' });
  const noted = noteOf(project, item.receiptId);
  const restore = failJournal(restoreDone, 'EIO');
  try {
    const second = start({ io: fs.promises });
    await second.listRecovery(workspace.workspaceId);
    assert.ok(fs.existsSync(noted), 'its note stays: the operation is not noted as over');
  } finally { restore(); }
  const third = start({ io: fs.promises });
  await third.listRecovery(workspace.workspaceId);
  assert.equal(fs.existsSync(noted), false);
  assert.equal((await third.resourceRecord(a.record.fileId)).status, 'ready');
});

// ── a part of a large text ─────────────────────────────────────────

/** Handles whose reads come back short, as a slow or network volume's may. */
const shortReads = (most) => ioWith({
  open: async (...args) => {
    const handle = await fs.promises.open(...args);
    const read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, most), position);
    return handle;
  },
});

test('[R4-18] a read that comes back short is read on: a part is as long as was asked, and ends between two characters', async () => {
  const { service, workspace, at } = await setup({ io: shortReads(5) });
  fs.writeFileSync(at('notes/long.txt'), '漢'.repeat(2000));
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/long.txt'));
  const part = await service.readTextRange(record.fileId, { offset: 0, length: 3000 });
  assert.equal(part.nextOffset, 3000);
  assert.equal(part.text, '漢'.repeat(1000));
});

test('[R4-18] a part ends after the last whole character that fits, not one before it', async () => {
  const { service, workspace, at } = await setup();
  fs.writeFileSync(at('notes/long.txt'), '漢'.repeat(100));
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/long.txt'));
  assert.deepEqual((({ text, nextOffset }) => [text, nextOffset])(await service.readTextRange(record.fileId, { offset: 0, length: 6 })), ['漢漢', 6]);
  assert.deepEqual((({ text, nextOffset }) => [text, nextOffset])(await service.readTextRange(record.fileId, { offset: 0, length: 7 })), ['漢漢', 6]);
});

test('[R4-18] a part asked for from inside a character starts at that character, and says so', async () => {
  const { service, workspace, at } = await setup();
  fs.writeFileSync(at('notes/long.txt'), `a${'漢'.repeat(100)}`);
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/long.txt'));
  const part = await service.readTextRange(record.fileId, { offset: 2, length: 60 });
  assert.equal(part.offset, 1);
  assert.ok(part.text.startsWith('漢'));
  assert.ok(!part.text.includes('�'), 'no character is cut in two');
});

test('[R4-18] a part too short to hold one character still holds one: a reader always moves on', async () => {
  const { service, workspace, at } = await setup();
  fs.writeFileSync(at('notes/long.txt'), '𝒳'.repeat(20));
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/long.txt'));
  const part = await service.readTextRange(record.fileId, { offset: 0, length: 1 });
  assert.deepEqual([part.text, part.nextOffset], ['𝒳', 4]);
});

test('[R4-18] bytes that are not UTF-8 are still read past: a reader always moves on', async () => {
  const { service, workspace, at } = await setup();
  fs.writeFileSync(at('notes/binary.txt'), Buffer.alloc(64, 0x80));
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/binary.txt'));
  const part = await service.readTextRange(record.fileId, { offset: 8, length: 16 });
  assert.equal(part.offset, 5, 'at most three bytes are stepped back over');
  assert.ok(part.nextOffset > part.offset);
});

test('[R4-18] a file that shrinks after its size was read ends a reader, instead of holding it at one offset for ever', async () => {
  let shrink = null;
  const io = ioWith({
    open: async (...args) => {
      const handle = await fs.promises.open(...args);
      const stat = handle.stat.bind(handle);
      handle.stat = async () => { const st = await stat(); if (shrink) { const run = shrink; shrink = null; run(); } return st; };
      return handle;
    },
  });
  const { service, workspace, at } = await setup({ io });
  fs.writeFileSync(at('notes/long.txt'), 'line\n'.repeat(1000));
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/long.txt'));
  shrink = () => fs.truncateSync(at('notes/long.txt'), 100);
  const part = await service.readTextRange(record.fileId, { offset: 200, length: 500 });
  assert.equal(part.text, '');
  assert.ok(part.nextOffset >= part.size, `done: next ${part.nextOffset}, size ${part.size}`);
  // shrunk in the middle of the part: what is there is given, and the reader is done at its end
  fs.writeFileSync(at('notes/long.txt'), 'line\n'.repeat(1000));
  shrink = () => fs.truncateSync(at('notes/long.txt'), 300);
  const cut = await service.readTextRange(record.fileId, { offset: 100, length: 500 });
  assert.equal(cut.nextOffset, 300);
  assert.equal(cut.size, 300);
});
