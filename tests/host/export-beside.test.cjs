// A file made from another one (a Word document written from a Markdown
// note) is put beside it as a new file of the workspace. It is never put
// over anything: a name that is taken gives the next free one, so a file
// someone has since worked on in another program is never replaced. Only
// the kinds of file this app writes can be made this way, and only within
// a size. On real temp folders; nothing here touches a real project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { fixture, sha, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { createProviderRegistry } = require('../../runtime/workspace/providers/provider-registry.cjs');
const { createWorkspaceDoor, watchingThrough } = require('../../runtime/workspace/door.cjs');
const { createSubscriptionHub } = require('../../runtime/workspace/subscriptions.cjs');

const setup = fixture(test, 'export');
const bytesOf = (marker) => new Uint8Array(Buffer.from(`PK\u0003\u0004 synthetic docx ${marker}`));

async function withDoor() {
  const made = await setup();
  const providers = createProviderRegistry({ service: made.service, providers: {}, remote: { workspaces: async () => [], workspaceOfFile: async () => null } });
  const hub = createSubscriptionHub({ service: watchingThrough(providers), send: () => {} });
  const door = createWorkspaceDoor({ service: made.service, providers, canvasFolder: async () => made.base, showInFileManager: () => {}, hub });
  const ask = (channel, ...args) => door[`workspace:${channel}`]({ senderId: 7 }, ...args);
  const note = await made.open('notes/a.md');
  return { ...made, ask, note };
}

test('a Word document made from a note is put beside it under the note\'s name, as a new file of the workspace', async () => {
  const { ask, at, note, service } = await withDoor();
  const record = await ask('export-beside', note.record.fileId, 'docx', bytesOf('ONE'), 'op-export-1');
  assert.equal(record.relativePath, 'notes/a.docx');
  assert.notEqual(record.fileId, note.record.fileId);
  assert.deepEqual(fs.readFileSync(at('notes/a.docx')), Buffer.from(bytesOf('ONE')));
  assert.equal(record.revision, sha(Buffer.from(bytesOf('ONE'))));
  assert.equal((await service.resourceRecord(record.fileId)).status, 'ready');
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n', 'the note is as it was');
});

test('making it again never replaces what is there: the next free name is taken, and a document of the same name made elsewhere is left alone', async () => {
  const { ask, at, note } = await withDoor();
  const first = await ask('export-beside', note.record.fileId, 'docx', bytesOf('ONE'), 'op-export-1');
  // someone works on the first one in a word processor
  fs.writeFileSync(at('notes/a.docx'), 'EDITED_IN_WORD');
  const second = await ask('export-beside', note.record.fileId, 'docx', bytesOf('TWO'), 'op-export-2');
  assert.equal(first.relativePath, 'notes/a.docx');
  assert.equal(second.relativePath, 'notes/a-2.docx');
  assert.equal(fs.readFileSync(at('notes/a.docx'), 'utf8'), 'EDITED_IN_WORD');
  assert.deepEqual(fs.readFileSync(at('notes/a-2.docx')), Buffer.from(bytesOf('TWO')));
});

test('the same request asked twice makes one document', async () => {
  const { ask, at, note } = await withDoor();
  const one = await ask('export-beside', note.record.fileId, 'docx', bytesOf('ONE'), 'op-export-1');
  const again = await ask('export-beside', note.record.fileId, 'docx', bytesOf('ONE'), 'op-export-1');
  assert.equal(again.fileId, one.fileId);
  assert.deepEqual(fs.readdirSync(at('notes')).sort(), ['a.docx', 'a.md']);
});

test('only what this app writes can be made, from bytes, within a size; a read-only folder gets nothing', async () => {
  const { ask, at, note, workspace, choose, base } = await withDoor();
  for (const extension of ['exe', 'md', 'sh', '../x', '']) {
    await assert.rejects(ask('export-beside', note.record.fileId, extension, bytesOf('X'), `op-${extension}`), { code: 'invalid-request' }, extension);
  }
  await assert.rejects(ask('export-beside', note.record.fileId, 'docx', 'not bytes', 'op-text'), { code: 'invalid-request' });
  await assert.rejects(ask('export-beside', note.record.fileId, 'docx', new Uint8Array(64 * 1024 * 1024 + 1), 'op-big'), { code: 'too-large' });
  assert.deepEqual(fs.readdirSync(at('notes')), ['a.md'], 'nothing was made');
  void workspace;

  // a folder this app may only read
  const readOnly = `${base}/read-only-export`;
  fs.mkdirSync(`${readOnly}/notes`, { recursive: true });
  fs.writeFileSync(`${readOnly}/notes/b.md`, 'B\n');
  fs.chmodSync(`${readOnly}/notes`, 0o555);
  fs.chmodSync(readOnly, 0o555);
  try {
    const ws = await choose(readOnly);
    const b = await ask('register-entry', ws.workspaceId, entryIdOf('notes/b.md'));
    await assert.rejects(ask('export-beside', b.fileId, 'docx', bytesOf('RO'), 'op-ro'));
    assert.deepEqual(fs.readdirSync(`${readOnly}/notes`), ['b.md']);
  } finally {
    fs.chmodSync(readOnly, 0o755);
    fs.chmodSync(`${readOnly}/notes`, 0o755);
  }
});
