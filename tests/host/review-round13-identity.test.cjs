// What the review of the R12-01 fix found (R13-01): a creation cut short after
// the new file had its name and before it had its identity was finished after a
// restart by asking what is registered at that name. An old identity whose file
// was gone, and not yet noticed, was taken for the new file's, and the old
// editor's save could overwrite it. Cut short at each step on real temp folders,
// the same journal and registry files a restart reads; nothing here touches a
// real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, sha, entryIdOf, registryOf, journalOf, leftovers } = require('./helpers/workspace-fixture.cjs');
const { createRegistry } = require('../../runtime/workspace/registry.cjs');
const { createJournal } = require('../../runtime/workspace/journal.cjs');
const { createFileOps } = require('../../runtime/workspace/file-ops.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const setup = fixture(test, 'review-r13');
const withoutWatcher = { watch: { watchFn: () => ({ close: () => {}, on: () => {} }), quietMs: 3600_000 } };
const NEVER = new Promise(() => {});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OLD = 'SAME_TEMPLATE\n';
const OTHER = 'ANOTHER_FILE_ENTIRELY\n';
const EDIT = 'WHAT_THE_OLD_TAB_HELD\n';
const KEY = 'op-new';

/** A workspace with an old identity at notes/fresh.md, whose editor is still open and whose file is gone. */
async function oldIdentityGone(oldStatus) {
  const made = await setup(withoutWatcher);
  const { service, at, open } = made;
  fs.writeFileSync(at('notes/fresh.md'), OLD);
  const old = await open('notes/fresh.md');
  fs.unlinkSync(at('notes/fresh.md'));
  if (oldStatus === 'missing') assert.equal((await service.reconcile(old.record.fileId)).status, 'missing');
  return { ...made, old };
}

/** What this application's parts are when a process opens the folder: the journal and registry on disk. */
async function partsOf(made) {
  const { record } = made.old;
  const grant = { rootPath: made.project, workspaceId: record.workspaceId, rootGrantId: record.locator.rootGrantId, readOnly: false };
  return {
    grant,
    registry: createRegistry({ ...grant, contracts: await loadContracts() }),
    journal: createJournal({ rootPath: made.project, readOnly: false, now: () => new Date().toISOString() }),
  };
}

const asked = (bytes) => [{ extension: 'md', origin: 'workspace', idempotencyKey: KEY, parentRelativePath: 'notes' }, { content: bytes, name: 'fresh' }];

/**
 * The process stops, for good, at a step of a creation. `attempt`: the name
 * about to be tried is noted. `published`: the file has its name. `created`:
 * that is noted. `identity`: the registry holds the file's identity and the
 * operation is not noted as done.
 */
async function cutShort(made, moment, bytes) {
  const { grant, registry, journal } = await partsOf(made);
  let reached;
  const there = new Promise((resolve) => { reached = resolve; });
  const stop = () => { reached(); return NEVER; };
  const ops = createFileOps({
    grant,
    registry: { ...registry, create: async (args) => { const record = await registry.create(args); return moment === 'identity' ? stop() : record; } },
    journal: { ...journal, append: async (entry) => { const noted = await journal.append(entry); return entry.opId === KEY && entry.phase === moment ? stop() : noted; } },
    io: { ...fs.promises, unlink: async (file) => { const answer = await fs.promises.unlink(file); return moment === 'published' && String(file).includes('.new.tdag-create-') ? stop() : answer; } },
  });
  ops.createFile(...asked(bytes)).catch(() => {});
  await Promise.race([there, pause(5000).then(() => { throw new Error(`the creation never came to ${moment}`); })]);
}

const retry = (service, made, bytes) => service.importText(made.request(KEY, { parentId: made.notes }), { text: bytes, name: 'fresh', provenance: { source: 'other' } });

/** What must hold after any of this. */
async function oneNewFile(made, service, created, bytes) {
  const { old, project, at } = made;
  assert.equal(fs.readFileSync(at('notes/fresh.md'), 'utf8'), bytes, 'the new file holds what it holds');
  assert.equal(created.revision, sha(bytes), 'what the creation answered is what is on disk');
  assert.notEqual(created.fileId, old.record.fileId, 'it has an identity of its own');
  assert.equal((await service.resourceRecord(old.record.fileId)).status, 'missing', 'the old identity is lost');
  assert.equal((await service.resourceRecord(created.fileId)).status, 'ready');
  const live = registryOf(project).resources.filter((r) => r.record.relativePath === 'notes/fresh.md' && r.record.status !== 'missing');
  assert.deepEqual(live.map((r) => r.record.fileId), [created.fileId], 'one live record at the name, and it is the new file');
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['a.md', 'fresh.md'], 'one file, and no second one under another name');
  assert.deepEqual(leftovers(at('notes')), []);
  const saved = await service.saveText(old.record.fileId, old.revision, EDIT, 'op-save-old');
  assert.equal(saved.status, 'conflict', 'the old editor does not reach the new file');
  assert.equal(fs.readFileSync(at('notes/fresh.md'), 'utf8'), bytes);
  assert.equal((await service.readText(created.fileId)).text, bytes, 'its reader reads the new file');
}

for (const moment of ['attempt', 'published', 'created', 'identity']) {
  for (const oldStatus of ['ready', 'missing']) {
    for (const [what, bytes] of [['the same content', OLD], ['other content', OTHER]]) {
      test(`[R13-01] cut short at ${moment}, old identity ${oldStatus}, ${what}: after a restart the new file has its own identity`, async () => {
        const made = await oldIdentityGone(oldStatus);
        await cutShort(made, moment, bytes);
        const restarted = made.start();
        const created = await retry(restarted, made, bytes);
        await oneNewFile(made, restarted, created, bytes);
      });
    }
  }
}

for (const moment of ['published', 'created', 'identity']) {
  test(`[R13-01] cut short at ${moment}: restarting again and asking again give the same file`, async () => {
    const made = await oldIdentityGone('ready');
    await cutShort(made, moment, OLD);
    const first = made.start();
    await first.rescanWorkspace(made.workspace.workspaceId);
    const created = await retry(first, made, OLD);
    const second = made.start();
    await second.rescanWorkspace(made.workspace.workspaceId);
    assert.equal((await retry(second, made, OLD)).fileId, created.fileId);
    const third = made.start();
    assert.equal((await retry(third, made, OLD)).fileId, created.fileId);
    await oneNewFile(made, third, created, OLD);
    assert.equal(registryOf(made.project).resources.filter((r) => r.record.relativePath === 'notes/fresh.md').length, 2, 'the old identity and one new one: no third');
  });
}

for (const moment of ['created', 'identity']) {
  test(`[R13-01] cut short at ${moment}, and another program puts other content at the name before the restart: what is answered is what is there`, async () => {
    const made = await oldIdentityGone('ready');
    await cutShort(made, moment, OLD);
    fs.writeFileSync(`${made.at('notes/fresh.md')}.theirs`, OTHER);
    fs.renameSync(`${made.at('notes/fresh.md')}.theirs`, made.at('notes/fresh.md'));
    const restarted = made.start();
    const created = await retry(restarted, made, OLD);
    await oneNewFile(made, restarted, created, OTHER);
  });

  test(`[R13-01] cut short at ${moment}, and the file is gone before the restart: nothing is claimed, and asking again makes the file`, async () => {
    const made = await oldIdentityGone('ready');
    await cutShort(made, moment, OLD);
    fs.unlinkSync(made.at('notes/fresh.md'));
    const restarted = made.start();
    const created = await retry(restarted, made, OTHER);
    assert.equal(fs.readFileSync(made.at('notes/fresh.md'), 'utf8'), OTHER);
    assert.notEqual(created.fileId, made.old.record.fileId);
    assert.equal(created.revision, sha(OTHER));
    assert.equal((await restarted.resourceRecord(made.old.record.fileId)).status, 'missing');
  });
}

test('[R13-01] another program puts a file at the name that was being tried: it is not this creation\'s, and the new file takes the next name', async () => {
  const made = await oldIdentityGone('ready');
  await cutShort(made, 'attempt', OLD);
  fs.writeFileSync(made.at('notes/fresh.md'), OLD);
  const restarted = made.start();
  const created = await retry(restarted, made, OLD);
  assert.equal(created.relativePath, 'notes/fresh-2.md');
  assert.notEqual(created.fileId, made.old.record.fileId);
  assert.equal(created.revision, sha(OLD));
});

/** The journal as an older version left it: its entries name no identity for the new file. */
function asAnOlderVersionLeftIt(project) {
  const lines = fs.readFileSync(journalOf(project), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  fs.writeFileSync(journalOf(project), lines.map(({ fileId, ...entry }) => JSON.stringify(entry.phase === 'done' ? { ...entry, fileId } : entry)).join('\n') + '\n');
}

for (const moment of ['published', 'created']) {
  test(`[R13-01] a journal an older version left, cut short at ${moment}: an old identity at the name is still not taken for the new file`, async () => {
    const made = await oldIdentityGone('ready');
    await cutShort(made, moment, OLD);
    asAnOlderVersionLeftIt(made.project);
    const restarted = made.start();
    const created = await retry(restarted, made, OLD);
    await oneNewFile(made, restarted, created, OLD);
  });
}

test('[R13-01] a journal an older version left, cut short once the identity was stored: the identity it was given stands, and no second one is made', async () => {
  const made = await oldIdentityGone('ready');
  await cutShort(made, 'identity', OLD);
  const stored = registryOf(made.project).resources.find((r) => r.record.relativePath === 'notes/fresh.md' && r.record.status !== 'missing').record.fileId;
  asAnOlderVersionLeftIt(made.project);
  const restarted = made.start();
  const created = await retry(restarted, made, OLD);
  assert.equal(created.fileId, stored);
  await oneNewFile(made, restarted, created, OLD);
});

test('[R13-01] the registry cannot be stored as the file is made, and the same request is asked again without a restart: the same file, not a second one', async () => {
  const made = await oldIdentityGone('ready');
  const { grant, registry, journal } = await partsOf(made);
  let fails = 1;
  const ops = createFileOps({
    grant,
    journal,
    registry: { ...registry, create: async (args) => { if (fails-- > 0) throw Object.assign(new Error('the disk said no'), { code: 'ENOSPC' }); return registry.create(args); } },
  });
  await assert.rejects(ops.createFile(...asked(OTHER)), /the disk said no/);
  assert.equal(fs.readFileSync(made.at('notes/fresh.md'), 'utf8'), OTHER, 'the file is kept');
  const created = await ops.createFile(...asked(OTHER));
  assert.notEqual(created.fileId, made.old.record.fileId);
  assert.equal(created.revision, sha(OTHER));
  assert.equal((await registry.get(made.old.record.fileId)).status, 'missing');
  assert.deepEqual(fs.readdirSync(made.at('notes')).sort(), ['a.md', 'fresh.md']);
  assert.equal((await ops.createFile(...asked(OTHER))).fileId, created.fileId);
});

test('[R13-01] the end of a creation cannot be noted, and the same request is asked again: the identity it was given, not a second one', async () => {
  const made = await oldIdentityGone('ready');
  const { grant, registry, journal } = await partsOf(made);
  let fails = 1;
  const ops = createFileOps({
    grant,
    registry,
    journal: { ...journal, append: async (entry) => { if (entry.phase === 'done' && fails-- > 0) throw Object.assign(new Error('the disk said no'), { code: 'ENOSPC' }); return journal.append(entry); } },
  });
  await assert.rejects(ops.createFile(...asked(OLD)), /the disk said no/);
  const stored = (await registry.findByPath('notes/fresh.md')).fileId;
  assert.notEqual(stored, made.old.record.fileId);
  assert.equal((await ops.createFile(...asked(OLD))).fileId, stored);
  assert.deepEqual(fs.readdirSync(made.at('notes')).sort(), ['a.md', 'fresh.md']);
  assert.equal((await registry.all()).filter((r) => r.relativePath === 'notes/fresh.md').length, 2);
});

test('[R13-01] control: a creation that is not cut short notes the identity before it gives the file its name', async () => {
  const made = await oldIdentityGone('ready');
  const restarted = made.start();
  const created = await retry(restarted, made, OLD);
  const phases = fs.readFileSync(journalOf(made.project), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.opId === KEY);
  assert.deepEqual(phases.map((e) => e.phase), ['intent', 'attempt', 'created', 'done']);
  assert.equal(phases[0].fileId, created.fileId);
  assert.equal(phases[3].fileId, created.fileId);
  assert.ok(entryIdOf('notes'));
});
