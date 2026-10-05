// Two things asked of a workspace at the same moment, on real temp folders:
// two moves onto one name, two first uses of a cold service, the same
// request sent twice before the first answer. What is checked is what is on
// disk and in the records afterwards, not only that the calls returned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, entryIdOf, registryOf, meetingAt } = require('./helpers/workspace-fixture.cjs');

const setup = fixture(test, 'concurrency');

test('two files moved onto the same name at once: one move happens, the other file stays where it was, and nothing is lost', async () => {
  // both moves reach the step that puts the file at its new name together, if nothing keeps them apart
  const { service, open, at, notes } = await setup({ io: meetingAt(['rename', 'link']) });
  const a = await open('notes/a.md');
  const keep = await open('papers/keep.md');
  const results = await Promise.allSettled([
    service.moveFile(a.record.fileId, notes, 'target.md', 'op-a'),
    service.moveFile(keep.record.fileId, notes, 'target.md', 'op-keep'),
  ]);
  const won = results.map((r) => r.status === 'fulfilled');
  assert.deepEqual([...won].sort(), [false, true], 'exactly one move succeeds');
  assert.equal(results[won.indexOf(false)].reason.code, 'exists');

  const [winner, loser] = won[0] ? [a, keep] : [keep, a];
  const loserPath = loser === a ? 'notes/a.md' : 'papers/keep.md';
  assert.equal(fs.readFileSync(at('notes/target.md'), 'utf8'), winner.text, 'the target holds the file that was moved');
  assert.equal(fs.readFileSync(at(loserPath), 'utf8'), loser.text, 'the other file is still at its own place with its own content');
  assert.equal(fs.existsSync(at(winner === a ? 'notes/a.md' : 'papers/keep.md')), false);
  assert.equal((await service.resourceRecord(winner.record.fileId)).relativePath, 'notes/target.md');
  assert.deepEqual({ ...(await service.resourceRecord(loser.record.fileId)) }, { ...loser.record, revision: loser.revision });
  // and the move that did not happen can be asked again under another name
  assert.equal((await service.moveFile(loser.record.fileId, notes, 'second.md', 'op-again')).relativePath, 'notes/second.md');
});

test('a move onto a name another program took in the meantime is refused, and that program\'s file is not replaced', async () => {
  const io = { ...fs.promises };
  let project;
  // the other program's file appears after this application looked and before it puts the file there
  for (const method of ['rename', 'link']) io[method] = async (...args) => { fs.writeFileSync(`${project}/notes/target.md`, 'THEIRS_Q7\n'); return fs.promises[method](...args); };
  const made = await setup({ io });
  project = made.project;
  const a = await made.open('notes/a.md');
  await assert.rejects(made.service.moveFile(a.record.fileId, made.notes, 'target.md', 'op-1'), { code: 'exists' });
  assert.equal(fs.readFileSync(made.at('notes/target.md'), 'utf8'), 'THEIRS_Q7\n');
  assert.equal(fs.readFileSync(made.at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
  assert.equal((await made.service.resourceRecord(a.record.fileId)).relativePath, 'notes/a.md');
});

test('two files given their identity at the same moment on a cold service both keep it, now and after a restart', async () => {
  const { start, workspace, project } = await setup();
  const cold = start();
  const [a, keep] = await Promise.all([
    cold.registerEntry(workspace.workspaceId, entryIdOf('notes/a.md')),
    cold.registerEntry(workspace.workspaceId, entryIdOf('papers/keep.md')),
  ]);
  assert.notEqual(a.fileId, keep.fileId);
  for (const service of [cold, start()]) {
    assert.equal((await service.resourceRecord(a.fileId))?.relativePath, 'notes/a.md');
    assert.equal((await service.resourceRecord(keep.fileId))?.relativePath, 'papers/keep.md');
  }
  assert.deepEqual(registryOf(project).resources.map((r) => r.record.fileId).sort(), [a.fileId, keep.fileId].sort());
});

test('the open workspaces are the same list for everyone who asks while a cold service is still loading them', async () => {
  const { start, choose, base } = await setup();
  const second = `${base}/another-project`;
  fs.mkdirSync(second);
  await choose(second);
  const cold = start();
  const lists = await Promise.all([cold.listWorkspaces(), cold.listWorkspaces(), cold.listWorkspaces()]);
  assert.deepEqual(lists.map((l) => l.length), [2, 2, 2]);
});

test('the same folder opened twice at the same moment is one workspace', async () => {
  const { start, choose, base, stateDir } = await setup();
  const fresh = `${base}/fresh-project`;
  fs.mkdirSync(fresh);
  const cold = start();
  const [one, two] = await Promise.all([choose(fresh, cold), cold.openRoot(fresh)]);
  assert.equal(one.workspaceId, two.workspaceId);
  assert.equal(one.rootGrantId, two.rootGrantId);
  assert.equal((await cold.listWorkspaces()).length, 2);
  const grants = JSON.parse(fs.readFileSync(`${stateDir}/workspace-grants.json`, 'utf8')).grants;
  assert.equal(Object.values(grants).filter((g) => g.workspaceId === one.workspaceId).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(`${fresh}/.thoughtdag/workspace.json`, 'utf8')).workspaceId, one.workspaceId);
});

test('the same creation asked twice before the first answer is one file with one identity', async () => {
  const { service, start, request, at, notes } = await setup();
  const [one, two] = await Promise.all([service.createFile(request('op-1', { parentId: notes })), service.createFile(request('op-1', { parentId: notes }))]);
  assert.equal(one.fileId, two.fileId);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'a.md']);
  // asked again afterwards, and after a restart, it is still that file
  assert.equal((await service.createFile(request('op-1', { parentId: notes }))).fileId, one.fileId);
  assert.equal((await start().createFile(request('op-1', { parentId: notes }))).fileId, one.fileId);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['Untitled-001.md', 'a.md']);
});

test('the same import asked twice before the first answer is one file', async () => {
  const { service, request, at, notes } = await setup();
  const ask = () => service.importText(request('op-1', { parentId: notes }), { text: 'COPIED_TEXT_H9\n', name: 'page', provenance: { source: 'other' } });
  const [one, two] = await Promise.all([ask(), ask()]);
  assert.equal(one.fileId, two.fileId);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['a.md', 'page.md']);
});
