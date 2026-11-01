// What the review of the R4-02 fix found (R12-01): the lock on a name being
// published kept newcomers out, but not a file's old identity. In the moment a
// new file has its name and not yet its identity, the old record of that name
// could be found again, could take the new file's content for its own, and its
// editor's save could overwrite the new file. On real temp folders, paused
// under the file-system calls at the moment the name is published; nothing here
// touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, sha, entryIdOf, registryOf } = require('./helpers/workspace-fixture.cjs');

const setup = fixture(test, 'review-r12');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Start something at a chosen moment without making that moment wait on it for good: what is held apart waits, and the moment goes on. */
const alongside = async (start) => { const run = start(); run.catch(() => {}); await Promise.race([run.then(() => {}, () => {}), pause(80)]); return { run }; };
const outcome = (run) => run.then((value) => ({ value }), (error) => ({ error }));
const withoutWatcher = { watch: { watchFn: () => ({ close: () => {}, on: () => {} }), quietMs: 3600_000 } };
const stuck = (work) => Promise.race([work, pause(5000).then(() => 'stuck')]);

const OLD = 'SAME_TEMPLATE\n';
const NEW_SAME = OLD;
const NEW_OTHER = 'ANOTHER_FILE_ENTIRELY\n';
const EDIT = 'WHAT_THE_OLD_TAB_HELD\n';

/**
 * A workspace with an old identity at notes/fresh.md whose file is gone, and a
 * way to make a new file at that name. `at(moment)` is run once the new file
 * has its name and before it has its identity; `moment` is told how the
 * creation or the copy went only afterwards.
 */
async function published(how, oldStatus, bytes) {
  let hook = null;
  const fire = async () => { if (hook) { const run = hook; hook = null; await run(); } };
  const io = {
    ...fs.promises,
    unlink: async (file) => { const answer = await fs.promises.unlink(file); if (String(file).includes('.new.tdag-create-')) await fire(); return answer; },
    copyFile: async (...args) => { const answer = await fs.promises.copyFile(...args); await fire(); return answer; },
  };
  const made = await setup({ io, ...withoutWatcher });
  const { service, at, open, request, notes, workspace } = made;
  fs.writeFileSync(at('notes/fresh.md'), OLD);
  fs.writeFileSync(at('papers/template.md'), bytes);
  const old = await open('notes/fresh.md');
  const template = await open('papers/template.md');
  fs.unlinkSync(at('notes/fresh.md'));
  if (oldStatus === 'missing') assert.equal((await service.reconcile(old.record.fileId)).status, 'missing');
  const events = [];
  await service.subscribeWorkspace(workspace.workspaceId, (event) => events.push(event));
  const make = () => (how === 'create'
    ? service.importText(request('op-create', { parentId: notes }), { text: bytes, name: 'fresh', provenance: { source: 'other' } })
    : service.copyFile(template.record.fileId, notes, 'fresh.md', 'op-copy'));
  return { ...made, old, events, make, at: at, setHook: (fn) => { hook = fn; } };
}

/** What must hold after any of this, whatever happened in the window. */
async function theNewFileIsWhole(made, created, bytes) {
  const { service, old, project, at } = made;
  assert.equal(fs.readFileSync(at('notes/fresh.md'), 'utf8'), bytes, 'the new file holds what it was made with');
  assert.equal(created.revision, sha(bytes), 'what the creation answered is what is on disk');
  assert.notEqual(created.fileId, old.record.fileId, 'it has an identity of its own');
  assert.equal((await service.resourceRecord(old.record.fileId)).status, 'missing', 'the old identity stays lost');
  assert.equal((await service.resourceRecord(created.fileId)).status, 'ready');
  const live = registryOf(project).resources.filter((r) => r.record.relativePath === 'notes/fresh.md' && r.record.status !== 'missing');
  assert.deepEqual(live.map((r) => r.record.fileId), [created.fileId], 'one live record at the name, and it is the new file');
}

const heardOfOld = (made) => made.events.filter((e) => e.fileId === made.old.record.fileId).map((e) => e.change);

for (const how of ['create', 'copy']) {
  for (const oldStatus of ['ready', 'missing']) {
    for (const [what, bytes] of [['the same content', NEW_SAME], ['other content', NEW_OTHER]]) {
      const name = `[R12-01] ${how}, old identity ${oldStatus}, ${what}`;

      test(`${name}: looking at the old identity while the name is published does not take the new file`, async () => {
        const made = await published(how, oldStatus, bytes);
        let looked = null;
        made.setHook(async () => { looked = await alongside(() => made.service.reconcile(made.old.record.fileId)); });
        const created = await made.make();
        await looked.run;
        await theNewFileIsWhole(made, created, bytes);
        assert.deepEqual(heardOfOld(made), [], 'nobody is told the old file came back or changed');
      });

      test(`${name}: a rescan while the name is published does not take the new file`, async () => {
        const made = await published(how, oldStatus, bytes);
        let looked = null;
        made.setHook(async () => { looked = await alongside(() => made.service.rescanWorkspace(made.workspace.workspaceId)); });
        const created = await made.make();
        await looked.run;
        await theNewFileIsWhole(made, created, bytes);
        assert.deepEqual(heardOfOld(made), []);
      });

      test(`${name}: the old identity's editor saving while the name is published does not reach the new file`, async () => {
        const made = await published(how, oldStatus, bytes);
        let saved = null;
        made.setHook(async () => { saved = await alongside(() => made.service.saveText(made.old.record.fileId, made.old.revision, EDIT, 'op-save')); });
        const created = await made.make();
        const answer = await saved.run;
        assert.equal(answer.status, 'conflict');
        await theNewFileIsWhole(made, created, bytes);
      });

      test(`${name}: looking at the old identity and then saving from its editor, as one person does`, async () => {
        const made = await published(how, oldStatus, bytes);
        let both = null;
        made.setHook(async () => { both = await alongside(async () => {
          const seen = await made.service.reconcile(made.old.record.fileId);
          const answer = await made.service.saveText(made.old.record.fileId, made.old.revision, EDIT, 'op-save');
          return { seen, answer };
        }); });
        const created = await made.make();
        const { answer } = await both.run;
        assert.equal(answer.status, 'conflict');
        await theNewFileIsWhole(made, created, bytes);
        assert.deepEqual(heardOfOld(made), []);
      });

      test(`${name}: saying by hand that the lost file is the new one, while it is published, is refused`, async () => {
        const made = await published(how, oldStatus, bytes);
        let linked = null;
        made.setHook(async () => { linked = await alongside(() => made.service.relink(made.old.record.fileId, entryIdOf('notes/fresh.md'))); });
        const created = await made.make();
        const answer = await outcome(linked.run);
        assert.equal(answer.error?.code, 'claimed');
        await theNewFileIsWhole(made, created, bytes);
        assert.deepEqual(heardOfOld(made), []);
      });
    }
  }
}

for (const how of ['create', 'copy']) {
  test(`[R12-01] ${how}: the old identity is not moved or trashed while the name is published: the new file stays where it was made`, async () => {
    for (const act of ['move', 'trash']) {
      const made = await published(how, 'ready', OLD);
      let acted = null;
      made.setHook(async () => { acted = await alongside(() => (act === 'move'
        ? made.service.moveFile(made.old.record.fileId, made.papers, 'moved-away.md', 'op-move')
        : made.service.trashFile(made.old.record.fileId, 'op-trash'))); });
      const created = await made.make();
      const answer = await outcome(acted.run);
      assert.equal(answer.error?.code, 'lost', `${act}: the old identity is lost by the time its turn comes`);
      await theNewFileIsWhole(made, created, OLD);
    }
  });

  test(`[R12-01] ${how}: a read through the old identity while the name is published tells nobody its file changed`, async () => {
    const made = await published(how, 'ready', NEW_OTHER);
    let read = null;
    made.setHook(async () => { read = await alongside(() => made.service.readText(made.old.record.fileId)); });
    const created = await made.make();
    await outcome(read.run);
    await theNewFileIsWhole(made, created, NEW_OTHER);
    assert.deepEqual(heardOfOld(made), []);
    assert.equal((await made.service.resourceRecord(made.old.record.fileId)).revision, sha(OLD), 'the old record still says what the old file held');
  });
}

test('[R12-01] a lost file is not found again under another name that is being published: not the new name, and not the creation\'s own temporary one', async () => {
  // the file went from notes/gone.md; a new file with the same words appears at notes/fresh.md
  for (const moment of ['before the name is taken', 'while the name is published']) {
    let hook = null;
    const fire = async () => { if (hook) { const run = hook; hook = null; await run(); } };
    const io = {
      ...fs.promises,
      link: async (...args) => { if (moment === 'before the name is taken') await fire(); return fs.promises.link(...args); },
      unlink: async (file) => { const answer = await fs.promises.unlink(file); if (moment === 'while the name is published' && String(file).includes('.new.tdag-create-')) await fire(); return answer; },
    };
    const made = await setup({ io, ...withoutWatcher });
    const { service, at, open, request, notes } = made;
    fs.writeFileSync(at('notes/gone.md'), OLD);
    const old = await open('notes/gone.md');
    fs.unlinkSync(at('notes/gone.md'));
    let looked = null;
    hook = async () => { looked = await alongside(() => service.reconcile(old.record.fileId)); };
    const created = await service.importText(request('op-create', { parentId: notes }), { text: OLD, name: 'fresh', provenance: { source: 'other' } });
    await looked.run;
    const after = await service.resourceRecord(old.record.fileId);
    assert.equal(after.relativePath, 'notes/gone.md', `${moment}: its record does not go to a name that is not its file`);
    assert.equal(after.status, 'missing', moment);
    assert.equal(fs.readFileSync(at('notes/fresh.md'), 'utf8'), OLD);
    assert.equal(created.revision, sha(OLD));
    assert.equal((await service.resourceRecord(created.fileId)).status, 'ready');
    // and its editor has nothing to save to
    assert.equal((await service.saveText(old.record.fileId, old.revision, EDIT, 'op-save')).status, 'conflict');
    assert.equal(fs.readFileSync(at('notes/fresh.md'), 'utf8'), OLD);
  }
});

// ── what was right and stays right ─────────────────────────────────

test('[R12-01] control: looking at the name while it is published, by name, finds the same new identity', async () => {
  const made = await published('create', 'missing', OLD);
  let looked = null;
  made.setHook(async () => { looked = await alongside(() => made.service.registerEntry(made.workspace.workspaceId, entryIdOf('notes/fresh.md'))); });
  const created = await made.make();
  const seen = await looked.run;
  assert.equal(seen.fileId, created.fileId, 'one file, one identity');
  await theNewFileIsWhole(made, created, OLD);
});

test('[R12-01] control: a save that has the name first keeps it: the creation takes the next free name', async () => {
  let release = null;
  let reached = null;
  const reachedSave = new Promise((resolve) => { reached = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const io = {
    ...fs.promises,
    rename: async (from, to) => { if (String(from).includes('.tdag-save-')) { reached(); await held; } return fs.promises.rename(from, to); },
  };
  const { service, at, open, request, notes } = await setup({ io, ...withoutWatcher });
  const a = await open('notes/a.md');
  const saving = service.saveText(a.record.fileId, a.revision, EDIT, 'op-save');
  await reachedSave;
  const creating = service.importText(request('op-create', { parentId: notes }), { text: 'NEW\n', name: 'a', provenance: { source: 'other' } });
  await pause(40);
  release();
  assert.equal((await saving).status, 'saved');
  const created = await creating;
  assert.equal(created.relativePath, 'notes/a-2.md');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), EDIT);
  assert.equal(fs.readFileSync(at('notes/a-2.md'), 'utf8'), 'NEW\n');
});

test('[R12-01] control: a lost file that really moved is still found at its new name, and a file put back as it was still comes back', async () => {
  const { service, at, open } = await setup(withoutWatcher);
  const a = await open('notes/a.md');
  fs.renameSync(at('notes/a.md'), at('papers/moved.md'));
  const moved = await service.reconcile(a.record.fileId);
  assert.equal(moved.relativePath, 'papers/moved.md');
  assert.equal(moved.status, 'ready');
  fs.unlinkSync(at('papers/moved.md'));
  assert.equal((await service.reconcile(a.record.fileId)).status, 'missing');
  fs.writeFileSync(at('papers/moved.md'), 'FIRST_TEXT_B3\n');
  const back = await service.reconcile(a.record.fileId);
  assert.equal(back.status, 'ready', 'the same words at the name it was lost from, and nobody else\'s: it is back');
  assert.equal((await service.saveText(a.record.fileId, a.revision, EDIT, 'op-save')).status, 'saved');
  assert.equal(fs.readFileSync(at('papers/moved.md'), 'utf8'), EDIT);
});

test('[R12-01] a temporary file of this application is not taken for a lost file that moved', async () => {
  const { service, at, open } = await setup(withoutWatcher);
  const a = await open('notes/a.md');
  fs.writeFileSync(at('papers/.keep.md.tdag-save-1234abcd'), 'FIRST_TEXT_B3\n');
  fs.unlinkSync(at('notes/a.md'));
  const after = await service.reconcile(a.record.fileId);
  assert.equal(after.status, 'missing');
  assert.equal(after.relativePath, 'notes/a.md');
});

test('[R12-01] everything that takes a name and a file together, at once, in both directions, never waits on itself', async () => {
  const { service, at, open, notes, papers, request, workspace } = await setup(withoutWatcher);
  const a = await open('notes/a.md');
  const b = await open('papers/keep.md');
  const work = [];
  for (let round = 0; round < 6; round++) {
    work.push(service.moveFile(a.record.fileId, papers, 'x.md', `op-a-${round}`).catch(() => {}));
    work.push(service.moveFile(b.record.fileId, notes, 'a.md', `op-b-${round}`).catch(() => {}));
    work.push(service.reconcile(a.record.fileId).catch(() => {}));
    work.push(service.reconcile(b.record.fileId).catch(() => {}));
    work.push(service.rescanWorkspace(workspace.workspaceId).catch(() => {}));
    work.push(service.saveText(a.record.fileId, a.revision, `A${round}\n`, `op-sa-${round}`).catch(() => {}));
    work.push(service.saveText(b.record.fileId, b.revision, `B${round}\n`, `op-sb-${round}`).catch(() => {}));
    work.push(service.copyFile(a.record.fileId, notes, 'keep.md', `op-ca-${round}`).catch(() => {}));
    work.push(service.copyFile(b.record.fileId, papers, 'a.md', `op-cb-${round}`).catch(() => {}));
    work.push(service.importText(request(`op-new-${round}`, { parentId: notes }), { text: 'N\n', name: 'a', provenance: { source: 'other' } }).catch(() => {}));
    work.push(service.relink(a.record.fileId, entryIdOf('notes/a.md')).catch(() => {}));
    work.push(service.trashFile(b.record.fileId, `op-t-${round}`).catch(() => {}));
    work.push(service.moveFolder(workspace.workspaceId, notes, null, `notes-${round}`, `op-f-${round}`).then(() => service.moveFolder(workspace.workspaceId, entryIdOf(`notes-${round}`), null, 'notes', `op-g-${round}`)).catch(() => {}));
  }
  assert.notEqual(await stuck(Promise.all(work)), 'stuck');
  assert.ok(at('notes'));
});
