// Who hears about a change to a file, and what a workspace this version may
// not write to refuses. Real temp folders; a stand-in for the folder watcher
// so that the moment of its signal is the test's to choose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fixture, sha, entryIdOf, journalOf } = require('./helpers/workspace-fixture.cjs');
const { createSubscriptionHub, releaseWithPage } = require('../../runtime/workspace/subscriptions.cjs');

const setup = fixture(test, 'notify');

/** A folder watcher that signals only when the test says so, and counts how many are open. */
function handWatcher() {
  const open = new Set();
  const watchFn = (_root, _options, onEvent) => {
    const watcher = { onEvent, close: () => open.delete(watcher), on: () => {} };
    open.add(watcher);
    return watcher;
  };
  return { watch: { watchFn, quietMs: 1 }, open, signal: () => { for (const w of open) w.onEvent('change', 'notes/a.md'); } };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

for (const [how, read] of [['its text', (s, id) => s.readText(id)], ['its bytes', (s, id) => s.readBytes(id)]]) {
  test(`a file changed by another program and read for ${how} before the watcher speaks: everyone listening still hears of the change, once`, async () => {
    const hand = handWatcher();
    const { service, workspace, open, at } = await setup({ watch: hand.watch });
    const a = await open('notes/a.md');
    const heard = [];
    await service.subscribeWorkspace(workspace.workspaceId, (event) => heard.push(event));

    fs.writeFileSync(at('notes/a.md'), 'EXTERNAL_EDIT_E6\n');
    const result = await read(service, a.record.fileId);
    assert.equal(result.revision, sha('EXTERNAL_EDIT_E6\n'));
    // the watcher's signal comes afterwards, and a rescan is asked for as well
    hand.signal();
    await settle();
    await service.rescanWorkspace(workspace.workspaceId);

    const about = heard.filter((e) => e.fileId === a.record.fileId);
    assert.deepEqual(about.map((e) => [e.change, e.observedRevision, e.opId]), [['content', sha('EXTERNAL_EDIT_E6\n'), null]]);
  });
}

test('the first look at a file\'s content is not news: nothing changed', async () => {
  const hand = handWatcher();
  const { service, workspace, at } = await setup({ watch: hand.watch });
  const record = await service.registerEntry(workspace.workspaceId, entryIdOf('notes/a.md'));
  assert.equal(record.revision, null);
  const heard = [];
  await service.subscribeWorkspace(workspace.workspaceId, (event) => heard.push(event));
  await service.readText(record.fileId);
  assert.deepEqual(heard, []);
  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'FIRST_TEXT_B3\n');
});

test('a folder whose records were written by a newer version is not written to: no save, creation, move, copy, trash or folder, and its records stay as they were', async () => {
  const { service, start, workspace, open, request, at, project, notes } = await setup();
  const a = await open('notes/a.md');
  await service.saveText(a.record.fileId, a.revision, 'SAVED_ONCE_T1\n', 'op-warm');
  // the same folder as a newer version of this application left it
  const registryFile = path.join(project, '.thoughtdag', 'resources.json');
  const newer = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  newer.schemaVersion = '1.2';
  fs.writeFileSync(registryFile, JSON.stringify(newer, null, 2) + '\n');
  const before = { registry: fs.readFileSync(registryFile, 'utf8'), journal: fs.readFileSync(journalOf(project), 'utf8'), tree: fs.readdirSync(project, { recursive: true }).filter((p) => !String(p).startsWith('.thoughtdag')).sort() };

  const older = start();
  const read = await older.readText(a.record.fileId);
  assert.equal(read.text, 'SAVED_ONCE_T1\n', 'reading still works');
  assert.equal((await older.saveText(a.record.fileId, read.revision, 'MUST_NOT_LAND_T2\n', 'op-save')).status, 'readonly');
  await assert.rejects(older.createFile(request('op-create', { parentId: notes })), { code: 'read-only' });
  await assert.rejects(older.importText(request('op-import'), { text: 'x', provenance: { source: 'other' } }), { code: 'read-only' });
  await assert.rejects(older.moveFile(a.record.fileId, undefined, 'moved.md', 'op-move'), { code: 'read-only' });
  await assert.rejects(older.copyFile(a.record.fileId, undefined, 'copy.md', 'op-copy'), { code: 'read-only' });
  await assert.rejects(older.trashFile(a.record.fileId, 'op-trash'), { code: 'read-only' });
  await assert.rejects(older.createFolder(workspace.workspaceId, undefined, 'new-folder'), { code: 'read-only' });

  assert.equal(fs.readFileSync(at('notes/a.md'), 'utf8'), 'SAVED_ONCE_T1\n');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before.registry);
  assert.equal(fs.readFileSync(journalOf(project), 'utf8'), before.journal);
  assert.deepEqual(fs.readdirSync(project, { recursive: true }).filter((p) => !String(p).startsWith('.thoughtdag')).sort(), before.tree);
});

// ── the page's subscriptions, as the shell holds them ──────────────────

test('a page that is closed, reloaded or loses its process takes its subscriptions with it, and the folders stop being watched', async () => {
  for (const leave of [
    (page) => page.emit('destroyed'),
    (page) => page.emit('render-process-gone', {}, { reason: 'crashed' }),
    (page) => page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'http://127.0.0.1:1/' }),
  ]) {
    const hand = handWatcher();
    const { service, workspace } = await setup({ watch: hand.watch });
    let rescans = 0;
    const counted = Object.assign(Object.create(service), { rescanWorkspace: (id) => { rescans++; return service.rescanWorkspace(id); } });
    const hub = createSubscriptionHub({ service: counted, send: () => {} });
    const page = Object.assign(new EventEmitter(), { id: 7 });
    releaseWithPage(hub, page);

    await hub.subscribe(workspace.workspaceId, page.id);
    assert.deepEqual(hub.active(), [workspace.workspaceId]);
    assert.equal(hand.open.size, 1);

    leave(page);
    await settle();
    assert.deepEqual(hub.active(), []);
    assert.equal(hand.open.size, 0, 'the folder is no longer watched');
    hub.rescanAll(); // the window coming back to the front looks at nothing that was released
    assert.equal(rescans, 0);
    // the folder is still granted, and a new page can subscribe again
    assert.equal((await service.listWorkspaces()).length, 1);
    await hub.subscribe(workspace.workspaceId, 8);
    assert.equal(hand.open.size, 1);
    hub.unsubscribe(workspace.workspaceId);
  }
});

test('a move within the same document is not a new page, and another page\'s leaving releases nothing of this one\'s', async () => {
  const hand = handWatcher();
  const { service, workspace } = await setup({ watch: hand.watch });
  const hub = createSubscriptionHub({ service, send: () => {} });
  const page = Object.assign(new EventEmitter(), { id: 7 });
  const other = Object.assign(new EventEmitter(), { id: 9 });
  releaseWithPage(hub, page);
  releaseWithPage(hub, other);
  await hub.subscribe(workspace.workspaceId, page.id);
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  page.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  other.emit('destroyed');
  assert.deepEqual(hub.active(), [workspace.workspaceId]);
  assert.equal(hand.open.size, 1);
  hub.unsubscribe(workspace.workspaceId);
});

test('a page that leaves while its subscription is still being set up does not leave it behind', async () => {
  const hand = handWatcher();
  const { service, workspace } = await setup({ watch: hand.watch });
  let letThrough;
  const slow = Object.assign(Object.create(service), { subscribeWorkspace: async (id, send) => { await new Promise((resolve) => { letThrough = resolve; }); return service.subscribeWorkspace(id, send); } });
  const hub = createSubscriptionHub({ service: slow, send: () => {} });
  const asking = hub.subscribe(workspace.workspaceId, 7);
  await settle();
  hub.releaseOwner(7);
  letThrough();
  await asking;
  await settle();
  assert.deepEqual(hub.active(), []);
  assert.equal(hand.open.size, 0);
});

test('a subscription that could not be made is not held, and asking again tries again', async () => {
  const { service, workspace } = await setup();
  let calls = 0;
  const flaky = Object.assign(Object.create(service), { subscribeWorkspace: async (id, send) => { if (++calls === 1) throw Object.assign(new Error('no'), { code: 'failed' }); return service.subscribeWorkspace(id, send); } });
  const hub = createSubscriptionHub({ service: flaky, send: () => {} });
  await assert.rejects(hub.subscribe(workspace.workspaceId, 7));
  assert.deepEqual(hub.active(), []);
  assert.equal(await hub.subscribe(workspace.workspaceId, 7), true);
  assert.deepEqual(hub.active(), [workspace.workspaceId]);
  hub.unsubscribe(workspace.workspaceId);
});
