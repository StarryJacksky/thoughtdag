// What a workspace does after something was cut short: a disk that filled
// while the old version was being kept, a crash between writing a file and
// noting that it was written, a retry that was itself interrupted, a journal
// whose last line is half a line. Every case restarts the service over the
// same folder and looks at the disk.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, errno, journalOf, journalLine, leftovers } = require('./helpers/workspace-fixture.cjs');
const { createJournal } = require('../../runtime/workspace/journal.cjs');

const setup = fixture(test, 'recovery');
const versionsOf = (project, fileId) => path.join(project, '.thoughtdag', 'recovery', 'versions', fileId);
const keptVersion = (project, fileId, revision) => fs.readFileSync(path.join(versionsOf(project, fileId), revision.replace('sha256:', '')), 'utf8');

/** File-system calls where the first write of the old version to the recovery area stops after three bytes, as on a full disk. */
function diskFillsWhileKeeping() {
  let failed = false;
  return {
    ...fs.promises,
    open: async (file, ...rest) => {
      const handle = await fs.promises.open(file, ...rest);
      if (failed || !String(file).includes(`${path.sep}recovery${path.sep}versions${path.sep}`)) return handle;
      failed = true;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'writeFile') return async (bytes) => { await target.writeFile(Buffer.from(bytes).subarray(0, 3)); throw errno('ENOSPC'); };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

test('a disk that fills while the old version is being kept: the save fails, and a retry never replaces the file with only part of the old version kept', async () => {
  const { service, start, open, at, project } = await setup({ io: diskFillsWhileKeeping() });
  fs.writeFileSync(at('notes/a.md'), 'ORIGINAL-CONTENT\n');
  const read = await open('notes/a.md');
  const first = await service.saveText(read.record.fileId, read.revision, 'NEW-CONTENT\n', 'op-1');
  assert.equal(first.status, 'error');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'ORIGINAL-CONTENT\n');

  for (const retry of [service, start()]) {
    const again = await retry.saveText(read.record.fileId, read.revision, 'NEW-CONTENT\n', 'op-2');
    if (again.status === 'saved') {
      assert.equal(keptVersion(project, read.record.fileId, read.revision), 'ORIGINAL-CONTENT\n', 'the whole old version is in the recovery area');
      assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'NEW-CONTENT\n');
    } else {
      assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'ORIGINAL-CONTENT\n');
    }
  }
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'NEW-CONTENT\n', 'with room on the disk the save goes through');
  assert.deepEqual(leftovers(versionsOf(project, read.record.fileId)), []);
});

test('part of an old version left in the recovery area by an earlier crash is not taken for the whole of it', async () => {
  const { service, open, at, project } = await setup();
  fs.writeFileSync(at('notes/a.md'), 'ORIGINAL-CONTENT\n');
  const read = await open('notes/a.md');
  fs.mkdirSync(versionsOf(project, read.record.fileId), { recursive: true });
  fs.writeFileSync(path.join(versionsOf(project, read.record.fileId), read.revision.replace('sha256:', '')), 'ORI');
  assert.equal((await service.saveText(read.record.fileId, read.revision, 'NEW-CONTENT\n', 'op-1')).status, 'saved');
  assert.equal(keptVersion(project, read.record.fileId, read.revision), 'ORIGINAL-CONTENT\n');
});

test('a crash after the new file was written and before that was noted: the retry returns that file and makes no second one', async () => {
  const { start, request, at, project, notes } = await setup();
  // what is on disk at that point: the intent, the name about to be tried, and the file itself
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  fs.appendFileSync(journalOf(project),
    journalLine({ opId: 'op-1', kind: 'create', phase: 'intent', parent: 'notes', extension: 'md', origin: 'workspace', recordOrigin: 'workspace', revision: sha('') })
    + journalLine({ opId: 'op-1', kind: 'create', phase: 'attempt', relativePath: 'notes/Untitled-001.md' }));
  fs.writeFileSync(at('notes/Untitled-001.md'), '');
  const restarted = start();
  const record = await restarted.createFile(request('op-1', { parentId: notes }));
  assert.equal(record.relativePath, 'notes/Untitled-001.md');
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'a.md']);
  assert.equal((await restarted.createFile(request('op-1', { parentId: notes }))).fileId, record.fileId);
});

test('every creation notes the name it is about to try before it writes there, so a crash at any point can be told from the journal', async () => {
  const { service, request, project, notes } = await setup();
  await service.createFile(request('op-1', { parentId: notes }));
  const phases = fs.readFileSync(journalOf(project), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.opId === 'op-1');
  assert.deepEqual(phases.map((e) => e.phase), ['intent', 'attempt', 'created', 'done']);
  assert.equal(phases[0].revision, sha(''));
  assert.equal(phases[1].relativePath, 'notes/Untitled-001.md');
});

test('a crash before the name that was about to be tried held this creation\'s content: nothing is claimed, and the retry makes exactly one file', async () => {
  const { start, request, at, project, notes } = await setup();
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  fs.appendFileSync(journalOf(project),
    journalLine({ opId: 'op-1', kind: 'create', phase: 'intent', parent: 'notes', extension: 'json', origin: 'workspace', recordOrigin: 'workspace', revision: sha('{}\n') })
    + journalLine({ opId: 'op-1', kind: 'create', phase: 'attempt', relativePath: 'notes/Untitled-001.json' }));
  // someone else's file took that name; it does not hold what this creation was writing
  fs.writeFileSync(at('notes/Untitled-001.json'), '{"theirs":true}\n');
  const record = await start().createFile({ ...request('op-1', { parentId: notes }), extension: 'json' });
  assert.equal(record.relativePath, 'notes/Untitled-002.json');
  assert.equal(fs.readFileSync(at('notes/Untitled-001.json'), 'utf8'), '{"theirs":true}\n');
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.json', 'Untitled-002.json', 'a.md']);
});

test('a save that failed, was asked again, and was cut short after the replacement is recognized as done after a restart', async () => {
  const { start, open, at, project } = await setup();
  const read = await open('notes/a.md');
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  const intent = { opId: 'op-1', kind: 'save', phase: 'intent', fileId: read.record.fileId, base: read.revision, next: sha('SECOND_TEXT_D5\n') };
  fs.appendFileSync(journalOf(project),
    journalLine({ ...intent, temp: '.a.md.tdag-save-first000' })
    + journalLine({ opId: 'op-1', kind: 'save', phase: 'failed' })
    + journalLine({ ...intent, temp: '.a.md.tdag-save-second00' }));
  // the second attempt got as far as putting the new content in place
  fs.writeFileSync(at('notes/a.md'), 'SECOND_TEXT_D5\n');
  const result = await start().saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1');
  assert.deepEqual(result, { status: 'saved', revision: sha('SECOND_TEXT_D5\n'), sourceRevision: null });
});

test('a save that failed, was asked again, and was cut short before the replacement leaves the old content and clears that attempt\'s temp file', async () => {
  const { start, open, at, project } = await setup();
  const read = await open('notes/a.md');
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  const intent = { opId: 'op-1', kind: 'save', phase: 'intent', fileId: read.record.fileId, base: read.revision, next: sha('SECOND_TEXT_D5\n') };
  fs.appendFileSync(journalOf(project),
    journalLine({ ...intent, temp: '.a.md.tdag-save-first000' })
    + journalLine({ opId: 'op-1', kind: 'save', phase: 'failed' })
    + journalLine({ ...intent, temp: '.a.md.tdag-save-second00' }));
  fs.writeFileSync(at('notes/.a.md.tdag-save-second00'), 'SECOND_TEXT_D5\n');
  const restarted = start();
  assert.equal((await restarted.readText(read.record.fileId)).text, 'FIRST_TEXT_B3\n');
  assert.deepEqual(leftovers(at('notes')), []);
  assert.equal((await restarted.saveText(read.record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-1')).status, 'saved');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SECOND_TEXT_D5\n');
});

test('what is noted after a half-written last line is still there when the journal is read again', async () => {
  const { service, start, request, at, project, notes } = await setup();
  await service.createFile(request('op-1', { parentId: notes }));
  fs.appendFileSync(journalOf(project), '{"opId":"op-torn","kind":"cre');
  // after the restart the first thing noted is a creation; it must survive the next restart
  const second = await start().createFile(request('op-2', { parentId: notes }));
  const again = await start().createFile(request('op-2', { parentId: notes }));
  assert.equal(again.fileId, second.fileId);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'Untitled-002.md', 'a.md']);
  const lines = fs.readFileSync(journalOf(project), 'utf8').split('\n').filter((l) => l.trim());
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  assert.equal(parsed.filter((e) => e === null).length, 1, 'the torn line stands alone');
  assert.ok(parsed.some((e) => e?.opId === 'op-2' && e.phase === 'done'));
});

test('the first thing noted after a half-written last line is not swallowed by it', async () => {
  const { project } = await setup();
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  fs.writeFileSync(journalOf(project), journalLine({ opId: 'op-0', kind: 'create', phase: 'intent' }) + journalLine({ opId: 'op-0', kind: 'create', phase: 'failed' }) + '{"opId":"op-torn","kind":"cre');
  // the next start notes that a save is about to happen, and is cut short right after
  await createJournal({ rootPath: project }).append({ opId: 'op-2', kind: 'save', phase: 'intent', fileId: 'file_x', base: sha('a'), next: sha('b'), temp: '.x.tdag-save-00000000' });
  const pending = await createJournal({ rootPath: project }).pending();
  assert.deepEqual(pending.map((op) => [op.opId, op.entries.map((e) => e.phase)]), [['op-2', ['intent']]]);
});

test('two things noted at the same moment are two whole lines', async () => {
  const { project } = await setup();
  const journal = createJournal({ rootPath: project });
  await Promise.all(Array.from({ length: 20 }, (_, n) => journal.append({ opId: `op-${n}`, kind: 'create', phase: 'intent', filler: 'x'.repeat(2000) })));
  const lines = fs.readFileSync(journalOf(project), 'utf8').split('\n').filter((l) => l.trim());
  assert.equal(lines.length, 20);
  assert.equal(new Set(lines.map((l) => JSON.parse(l).opId)).size, 20);
});

test('a move cut short between giving the file its new name and taking away the old one ends with the file under the new name only', async () => {
  const { start, open, at, project } = await setup();
  const read = await open('notes/a.md');
  fs.mkdirSync(path.dirname(journalOf(project)), { recursive: true });
  fs.appendFileSync(journalOf(project), journalLine({ opId: 'op-1', kind: 'move', phase: 'intent', fileId: read.record.fileId, from: 'notes/a.md', to: 'papers/a.md' }));
  fs.linkSync(at('notes/a.md'), at('papers/a.md'));
  const restarted = start();
  const record = await restarted.moveFile(read.record.fileId, undefined, 'ignored-because-done.md', 'op-1');
  assert.equal(record.relativePath, 'papers/a.md');
  assert.equal(fs.existsSync(at('notes/a.md')), false);
  assert.equal(fs.readFileSync(at('papers/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
});
