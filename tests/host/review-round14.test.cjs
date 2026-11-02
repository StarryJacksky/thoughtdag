// What the review of T15..T29 found on the host (R14-01, R14-02, R14-05). Real temp folders and
// the stand-in CLI; nothing here touches a real project, session or login.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, sha, registryOf } = require('./helpers/workspace-fixture.cjs');
const { installFakeRuntimes, runToEnd } = require('../helpers/fake-runtimes.cjs');
const { createRegistry } = require('../../runtime/workspace/registry.cjs');
const { createJournal } = require('../../runtime/workspace/journal.cjs');
const { createFileOps } = require('../../runtime/workspace/file-ops.cjs');
const { createTargetScheduler } = require('../../runtime/execution/target-scheduler.cjs');
const { loadContracts } = require('../../shared/schemas/host.cjs');

const fake = installFakeRuntimes();
const { createClaudeRuntime } = require('../../runtime/agents/claude.cjs');
test.after(() => fake.cleanup());
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// ── R14-01: a claim of reading only is believed only of a run that is in research ──

function schedule() {
  const started = [];
  const scheduler = createTargetScheduler({
    maxActiveRuns: 5, onEvent: () => {},
    runtimeFor: () => ({ run: async (req) => { started.push(req.prompt); return `native-${req.prompt}`; }, abort: () => true, answer: () => true }),
  });
  return { started, scheduler };
}
test('[R14-01] a run at work that says it only reads is a writer: what it says does not make it research', async () => {
  const { started, scheduler } = schedule();
  await scheduler.enqueue({ cwd: '/synthetic/w', prompt: 'writer', target: { targetId: 'a', writes: true } });
  await scheduler.enqueue({ cwd: '/synthetic/w', prompt: 'claims-reading', target: { targetId: 'b', writes: false } });
  await pause();
  assert.deepEqual(started, ['writer']);
});
test('[R14-01] control: a run in research goes beside a writer', async () => {
  const { started, scheduler } = schedule();
  await scheduler.enqueue({ cwd: '/synthetic/w', prompt: 'writer', target: { targetId: 'a', writes: true } });
  await scheduler.enqueue({ cwd: '/synthetic/w', prompt: 'reader', mode: 'research', target: { targetId: 'b', writes: false } });
  await pause();
  assert.deepEqual(started, ['writer', 'reader']);
});
test('[R14-01] a run in research that says it writes is a writer: the claim to write is believed', async () => {
  const { started, scheduler } = schedule();
  await scheduler.enqueue({ cwd: '/synthetic/w', prompt: 'writer', target: { targetId: 'a', writes: true } });
  await scheduler.enqueue({ cwd: '/synthetic/w', prompt: 'odd', mode: 'research', target: { targetId: 'b', writes: true } });
  await pause();
  assert.deepEqual(started, ['writer']);
});

// ── R14-02: a creation taken up again does not take what another has made since ──

const setup = fixture(test, 'review-r14');
const withoutWatcher = { watch: { watchFn: () => ({ close: () => {}, on: () => {} }), quietMs: 3600_000 } };
const NAME = 'notes/fresh.md';
const created = (bytes, key) => [{ extension: 'md', origin: 'workspace', idempotencyKey: key, parentRelativePath: 'notes' }, { content: bytes, name: 'fresh' }];

async function partsOf(made) {
  const seed = await made.open('notes/a.md');
  const grant = { rootPath: made.project, workspaceId: seed.record.workspaceId, rootGrantId: seed.record.locator.rootGrantId, readOnly: false };
  const contracts = await loadContracts();
  return { grant, registry: createRegistry({ ...grant, contracts }), journal: createJournal({ rootPath: made.project, readOnly: false, now: () => new Date().toISOString() }) };
}
/** A made, its file with its name, its identity not stored; then A's file gone. */
async function aLeftOpen(made) {
  const { grant, registry, journal } = await partsOf(made);
  let fails = 1;
  const failing = createFileOps({ grant, journal, registry: { ...registry, create: async (args) => { if (fails-- > 0) throw Object.assign(new Error('the disk said no'), { code: 'ENOSPC' }); return registry.create(args); } } });
  await assert.rejects(failing.createFile(...created('FILE_A\n', 'op-a')), /the disk said no/);
  fs.unlinkSync(made.at(NAME));
  return { grant, registry, journal, ops: createFileOps({ grant, registry, journal }) };
}

for (const [what, bytesOfB] of [['other content', 'FILE_B\n'], ['the same content', 'FILE_A\n']]) {
  test(`[R14-02] A taken up again after B took the name, ${what}: B keeps its name, its identity and its bytes, and A is made anew`, async () => {
    const made = await setup(withoutWatcher);
    const { ops, registry } = await aLeftOpen(made);
    const b = await ops.createFile(...created(bytesOfB, 'op-b'));
    assert.equal(b.relativePath, NAME);
    const a = await ops.createFile(...created('FILE_A\n', 'op-a'));
    assert.notEqual(a.fileId, b.fileId);
    assert.notEqual(a.relativePath, NAME, 'A does not claim the name');
    assert.equal((await registry.get(b.fileId)).status, 'ready');
    assert.equal(fs.readFileSync(made.at(NAME), 'utf8'), bytesOfB);
    assert.equal(fs.readFileSync(made.at(a.relativePath), 'utf8'), 'FILE_A\n');
    const saved = await ops.saveText(b.fileId, b.revision, 'B_EDITED\n', 'op-save-b');
    assert.equal(saved.status, 'saved');
    assert.equal(fs.readFileSync(made.at(NAME), 'utf8'), 'B_EDITED\n');
  });

  test(`[R14-02] the same after a restart, ${what}: what the crash left does not take B either`, async () => {
    const made = await setup(withoutWatcher);
    const { ops } = await aLeftOpen(made);
    const b = await ops.createFile(...created(bytesOfB, 'op-b'));
    const restarted = made.start();
    await restarted.rescanWorkspace(made.workspace.workspaceId);
    assert.equal((await restarted.resourceRecord(b.fileId)).status, 'ready');
    assert.equal(fs.readFileSync(made.at(NAME), 'utf8'), bytesOfB);
    const live = registryOf(made.project).resources.filter((r) => r.record.relativePath === NAME && r.record.status !== 'missing');
    assert.deepEqual(live.map((r) => r.record.fileId), [b.fileId]);
  });
}

test('[R14-02] control: another program put a file at the name, and nothing is registered for it: A takes it, with what it holds', async () => {
  const made = await setup(withoutWatcher);
  const { ops } = await aLeftOpen(made);
  fs.writeFileSync(made.at(NAME), 'THEIRS\n');
  const a = await ops.createFile(...created('FILE_A\n', 'op-a'));
  assert.equal(a.relativePath, NAME);
  assert.equal(a.revision, sha('THEIRS\n'));
});

test('[R14-02] control: A\'s file still there: A is finished, with the identity it noted', async () => {
  const made = await setup(withoutWatcher);
  const { grant, registry, journal } = await partsOf(made);
  let fails = 1;
  const failing = createFileOps({ grant, journal, registry: { ...registry, create: async (args) => { if (fails-- > 0) throw Object.assign(new Error('no'), { code: 'ENOSPC' }); return registry.create(args); } } });
  await assert.rejects(failing.createFile(...created('FILE_A\n', 'op-a')));
  const a = await createFileOps({ grant, registry, journal }).createFile(...created('FILE_A\n', 'op-a'));
  assert.equal(a.relativePath, NAME);
  assert.equal(a.revision, sha('FILE_A\n'));
});

// ── R14-05: a turn that failed has failed, whatever the process does next ──

const claudeWith = (t, script) => {
  fake.clear();
  fake.script(script);
  const claude = createClaudeRuntime();
  t.after(() => claude.shutdown());
  return claude;
};
const go = (claude) => runToEnd(claude, { runtime: 'claude-code', cwd: fake.project, prompt: 'hello', model: { provider: 'claude-code', id: 'sonnet' } });
const kinds = (events) => events.filter((e) => e.type === 'run_error' || e.type === 'run_end').map((e) => (e.type === 'run_end' ? `end:${e.how}` : 'error'));

test('[R14-05] a failed result and then a clean exit: failed, with the error before the end', async (t) => {
  const claude = claudeWith(t, { failure: 'IT_FAILED', failureExit: 0 });
  const events = await go(claude);
  assert.deepEqual(kinds(events), ['error', 'end:error']);
  assert.equal(events.find((e) => e.type === 'run_error').message, 'IT_FAILED');
  assert.equal(events.at(-1).text, '');
});

test('[R14-05] a failed result with no words and a clean exit at once: failed, and what is said is said', async (t) => {
  const claude = claudeWith(t, { failureNoText: true, failureExit: 0 });
  const events = await go(claude);
  assert.deepEqual(kinds(events), ['error', 'end:error']);
});

test('[R14-05] words streamed before the failure are not an answer', async (t) => {
  const claude = claudeWith(t, { streamThenFail: 'HALF_AN_ANSWER', failureExit: 0 });
  const events = await go(claude);
  assert.deepEqual(kinds(events), ['error', 'end:error']);
  assert.equal(events.at(-1).text, '');
  assert.equal(events.find((e) => e.type === 'binding').turnStatus, 'failed');
});

test('[R14-05] the reason that comes on stderr after the result is still said', async (t) => {
  const claude = claudeWith(t, { failureNoText: true, failureExit: 1, lateStderr: 'No conversation found with session ID: x' });
  const events = await go(claude);
  assert.equal(events.find((e) => e.type === 'run_error').code, 'session-missing');
  assert.deepEqual(kinds(events), ['error', 'end:error']);
});

test('[R14-05] stopped as it fails: stopped, and no error is said', async (t) => {
  const claude = claudeWith(t, { hold: true });
  const events = [];
  let ended; const end = new Promise((resolve) => { ended = resolve; });
  const id = await claude.run({ runtime: 'claude-code', cwd: fake.project, prompt: 'hello', model: { provider: 'claude-code', id: 'sonnet' } }, ({ event }) => { events.push(event); if (event.type === 'run_end') ended(); });
  for (let i = 0; i < 300 && !events.some((e) => e.type === 'session'); i++) await pause(10);
  claude.abort(id);
  await end;
  assert.deepEqual(kinds(events), ['end:aborted']);
});
