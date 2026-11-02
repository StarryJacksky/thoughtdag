// What the Codex adapter promises (T15), against a stand-in that refuses what
// the real server was seen to refuse. What a run asks for travels as the server
// supports it; what cannot be done is said, and nothing is sent in its place.
// Nothing here talks to a real CLI or a real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installFakeRuntimes, runToEnd } = require('../helpers/fake-runtimes.cjs');

const fake = installFakeRuntimes();
const { createCodexRuntime } = require('../../runtime/agents/codex.cjs');
const { probeCodex } = require('../../runtime/agents/codex-capabilities.cjs');
const { materializeRun } = require('../../runtime/agents/ops.cjs');

const THREAD = '11111111-2222-4333-8444-555555555555';
const FILE = path.join(fake.sessions, `rollout-${THREAD}.jsonl`);
const MODEL = { provider: 'codex', id: 'gpt-synthetic' };
const SUPPORTED = { readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'supported' };

test.after(() => fake.cleanup());
/** A runtime of its own for each test, so that a server, a probe and a script are only that test's. */
function fresh(t, script = {}, options = {}) {
  fake.clear();
  fake.script(script);
  const codex = createCodexRuntime(options);
  t.after(() => codex.shutdown());
  return codex;
}
const asked = () => fake.read('codex').filter((r) => r.kind === 'in').map((r) => r.msg);
const methods = () => asked().map((m) => m.method);
const running = () => asked().map((m) => m.method).filter((m) => !['initialize', 'initialized', 'model/list', 'thread/read', 'thread/turns/list', 'command/exec'].includes(m));
const servers = () => fake.read('codex').filter((r) => r.kind === 'argv' && r.argv.length === 1 && r.argv[0] === 'app-server');
const errorOf = (events) => events.find((e) => e.type === 'run_error');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** A run started and its events as they come, for what is done while it is under way. */
async function under(codex, req) {
  const events = [];
  let ended; const end = new Promise((resolve) => { ended = resolve; });
  const runId = await codex.run({ runtime: 'codex', cwd: fake.project, model: MODEL, ...req }, ({ event }) => { events.push(event); if (event.type === 'run_end') ended(); });
  return { runId, events, end };
}
const until = async (check, ms = 5000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > ms) throw new Error('it did not come to that'); await pause(10); } };

test('[T15] the handshake comes first, once, and only then anything else', async (t) => {
  const codex = fresh(t);
  await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'hello', model: MODEL });
  const all = methods();
  assert.deepEqual(all.slice(0, 2), ['initialize', 'initialized']);
  assert.equal(all.filter((m) => m === 'initialize').length, 1);
  assert.deepEqual(running(), ['thread/start', 'turn/start']);
});

test('[T15][L03] two asking at once while the server starts: one server, one handshake', async (t) => {
  const codex = fresh(t, { delay: { initialize: 50 } });
  const [catalog, events] = await Promise.all([codex.models(), runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'hello', model: MODEL })]);
  assert.equal(catalog.installed, true);
  assert.equal(events.at(-1).how, 'end');
  assert.equal(servers().length, 1);
  assert.equal(methods().filter((m) => m === 'initialize').length, 1);
});

test('[T15][L03] a server that went away is started again, and the old one\'s exit does not take the new one with it', async (t) => {
  const codex = fresh(t);
  await codex.models();
  codex.shutdown();
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'again', model: MODEL });
  assert.equal(events.at(-1).how, 'end');
  assert.equal(servers().length, 2);
});

test('[T15] the thread is told apart from its session: the run answers with the thread\'s id and the turn that really ran', async (t) => {
  const codex = fresh(t);
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'hello', model: MODEL });
  const turn = asked().find((m) => m.method === 'turn/start');
  const session = events.find((e) => e.type === 'session');
  assert.equal(session.threadId, turn.params.threadId);
  assert.equal(session.sessionId, turn.params.threadId, 'what a session file is found by stays the thread id');
  assert.equal(session.nativeSessionId, `tree-of-${turn.params.threadId}`);
  const binding = events.find((e) => e.type === 'binding');
  assert.equal(binding.threadId, turn.params.threadId);
  assert.equal(binding.nativeSessionId, `tree-of-${turn.params.threadId}`);
  assert.equal(path.basename(binding.sessionFile), `rollout-${turn.params.threadId}.jsonl`);
  assert.match(binding.lastCompletedTurnId, /^[0-9a-f-]{36}$/);
  assert.equal(binding.turnStatus, 'completed');
});

test('[T15] resume names the thread, and the next turn goes on it', async (t) => {
  const codex = fresh(t);
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'go on', sessionPath: FILE, model: MODEL });
  assert.deepEqual(running(), ['thread/resume', 'turn/start']);
  assert.equal(asked().find((m) => m.method === 'thread/resume').params.threadId, THREAD);
  assert.equal(asked().find((m) => m.method === 'turn/start').params.threadId, THREAD);
  assert.equal(events.at(-1).how, 'end');
});

test('[T15] a turn that did not finish is not called completed: the binding keeps the one before it', async (t) => {
  const codex = fresh(t, { hold: true });
  const run = await under(codex, { prompt: 'long', sessionPath: FILE, lastCompletedTurnId: 'turn-before' });
  await until(() => methods().includes('turn/start'));
  await pause(30);
  codex.abort(run.runId);
  await run.end;
  const binding = run.events.find((e) => e.type === 'binding');
  assert.equal(binding.lastCompletedTurnId, 'turn-before');
  assert.equal(binding.turnStatus, 'interrupted');
  assert.equal(run.events.at(-1).how, 'aborted');
});

test('[T15] a fork carries its boundary: the turn it goes through, not the whole thread', async (t) => {
  const codex = fresh(t, { turns: { [THREAD]: [{ id: 'turn-1', status: 'completed' }, { id: 'turn-2', status: 'completed' }] } });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'branch', sessionPath: FILE, forkEntryId: 'turn-1', model: MODEL });
  const fork = asked().find((m) => m.method === 'thread/fork');
  assert.equal(fork.params.threadId, THREAD);
  assert.equal(fork.params.lastTurnId, 'turn-1');
  const turn = asked().find((m) => m.method === 'turn/start');
  assert.notEqual(turn.params.threadId, THREAD, 'the next turn goes on the fork, not on the thread it came from');
  assert.equal(events.at(-1).how, 'end');
});

test('[T15] a boundary found on a later page of turns is found', async (t) => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: `turn-${i}`, status: 'completed' }));
  const codex = fresh(t, { turns: { [THREAD]: many } });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'branch', sessionPath: FILE, forkEntryId: 'turn-249', model: MODEL });
  assert.equal(events.at(-1).how, 'end');
  assert.equal(asked().find((m) => m.method === 'thread/fork').params.lastTurnId, 'turn-249');
});

for (const [status, name] of [['inProgress', 'in progress'], ['interrupted', 'interrupted'], ['failed', 'failed']]) {
  test(`[T15] a fork at a turn ${name} is refused, and nothing is sent in its place`, async (t) => {
    const codex = fresh(t, { turns: { [THREAD]: [{ id: 'turn-1', status }] } });
    const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'branch', sessionPath: FILE, forkEntryId: 'turn-1', model: MODEL });
    assert.equal(errorOf(events).code, 'fork-partial-turn');
    assert.deepEqual(running(), []);
    assert.equal(events.at(-1).how, 'error');
  });
}

test('[T15] a fork at a turn the thread does not have is refused', async (t) => {
  const codex = fresh(t, { turns: { [THREAD]: [{ id: 'turn-1', status: 'completed' }] } });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'branch', sessionPath: FILE, forkEntryId: 'turn-elsewhere', model: MODEL });
  assert.equal(errorOf(events).code, 'fork-partial-turn');
  assert.deepEqual(running(), []);
});

test('[T15] a version whose fork has no boundary is not asked to fork: the whole history would come along', async (t) => {
  const codex = fresh(t, { noLastTurnId: true, turns: { [THREAD]: [{ id: 'turn-1', status: 'completed' }] } });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'branch', sessionPath: FILE, forkEntryId: 'turn-1', model: MODEL });
  assert.equal(errorOf(events).code, 'fork-unsupported');
  assert.deepEqual(running(), []);
});

test('[T15] a fork whose turns cannot be looked at is refused: it is not known to be whole', async (t) => {
  const codex = fresh(t, { without: ['thread/turns/list'], turns: { [THREAD]: [{ id: 'turn-1', status: 'completed' }] } });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'branch', sessionPath: FILE, forkEntryId: 'turn-1', model: MODEL });
  assert.equal(errorOf(events).code, 'fork-unsupported');
  assert.deepEqual(running(), []);
});

test('[T15] a method the server does not know ends the run with that said: no other way in is tried', async (t) => {
  const codex = fresh(t, { without: ['thread/resume'] });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'go on', sessionPath: FILE, model: MODEL });
  assert.equal(errorOf(events).code, 'method-unsupported');
  assert.deepEqual(running(), ['thread/resume']);
  assert.equal(events.at(-1).how, 'error');
});

test('[T15] a thread at work in this server is not resumed, and no new thread is started instead', async (t) => {
  const codex = fresh(t, { activeThreads: [THREAD] });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'go on', sessionPath: FILE, model: MODEL });
  assert.equal(errorOf(events).code, 'session-busy');
  assert.deepEqual(running(), []);
});

test('[T15] the server saying a thread is busy elsewhere is said as that, and no new thread is started instead', async (t) => {
  const codex = fresh(t, { busyThreads: [THREAD] });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'go on', sessionPath: FILE, model: MODEL });
  assert.equal(errorOf(events).code, 'session-busy');
  assert.deepEqual(running(), ['thread/resume']);
});

test('[T15][L01] stopped while the thread is being started: the prompt is never sent', async (t) => {
  const codex = fresh(t, { delay: { 'thread/start': 120 } });
  const run = await under(codex, { prompt: 'PROMPT_NOT_TO_BE_SENT' });
  await until(() => methods().includes('thread/start'));
  assert.equal(codex.abort(run.runId), true);
  await run.end;
  assert.equal(methods().includes('turn/start'), false);
  assert.equal(run.events.at(-1).how, 'aborted');
  assert.equal(errorOf(run.events), undefined);
});

test('[T15][L01] stopped before the server has even answered: the prompt is never sent', async (t) => {
  const codex = fresh(t, { delay: { initialize: 120 } });
  const run = await under(codex, { prompt: 'PROMPT_NOT_TO_BE_SENT' });
  assert.equal(codex.abort(run.runId), true);
  await run.end;
  assert.deepEqual(running(), []);
  assert.equal(run.events.at(-1).how, 'aborted');
});

test('[T15][L01] stopped while the turn is being started: it is interrupted the moment its id is known', async (t) => {
  const codex = fresh(t, { delay: { 'turn/start': 120 }, hold: true });
  const run = await under(codex, { prompt: 'hello' });
  await until(() => methods().includes('turn/start'));
  assert.equal(codex.abort(run.runId), true);
  await run.end;
  assert.equal(methods().includes('turn/interrupt'), true);
  assert.equal(run.events.at(-1).how, 'aborted');
});

test('[T15] research on a version not known to keep to its inputs is not run at all', async (t) => {
  const codex = fresh(t, { sandbox: { read: 'open', network: 'closed' } });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'look', mode: 'research', model: MODEL });
  assert.equal(errorOf(events).code, 'research-unverified');
  assert.deepEqual(running(), []);
});

test('[T15] research on a version known to keep to its inputs asks for no writing, no network and no approvals', async (t) => {
  const codex = fresh(t, {}, { probe: async () => ({ runtime: 'codex', binaryVersion: '9.9.9-synthetic', probedAt: 'now', capabilities: SUPPORTED }) });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'look', mode: 'research', model: MODEL });
  assert.equal(events.at(-1).how, 'end');
  const start = asked().find((m) => m.method === 'thread/start');
  assert.equal(start.params.sandbox, 'read-only');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.deepEqual(asked().find((m) => m.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
});

test('[T15] research goes on in no session, whatever it was given', async (t) => {
  const codex = fresh(t, {}, { probe: async () => ({ runtime: 'codex', binaryVersion: '9.9.9-synthetic', probedAt: 'now', capabilities: SUPPORTED }) });
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'look', mode: 'research', sessionPath: FILE, model: MODEL });
  assert.equal(errorOf(events).code, 'research-unverified');
  assert.deepEqual(running(), []);
});

// ── the probe ──

const binary = () => path.join(fake.bin, 'codex');
async function probe(t, script) {
  fake.clear();
  fake.script(script);
  return probeCodex(binary());
}

test('[T15] the probe reports what this version can do, and its version', async (t) => {
  const report = await probe(t, { sandbox: { read: 'closed', network: 'closed' } });
  assert.equal(report.runtime, 'codex');
  assert.equal(report.binaryVersion, '9.9.9-synthetic');
  assert.ok(Date.parse(report.probedAt));
  assert.deepEqual(report.capabilities, {
    fresh: 'supported', resume: 'supported', forkAtCompletedTurn: 'supported', observeState: 'supported', cancel: 'supported', approvals: 'supported',
    readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'unknown',
  });
});

test('[T15] a sandbox that lets a file outside be read is not called read-only to its roots', async (t) => {
  const report = await probe(t, { sandbox: { read: 'open', network: 'closed' } });
  assert.equal(report.capabilities.readOnlyRoots, 'unsupported');
  assert.equal(report.capabilities.networkRestriction, 'supported');
});

test('[T15] a sandbox that lets the network through is not called offline', async (t) => {
  const report = await probe(t, { sandbox: { read: 'closed', network: 'open' } });
  assert.equal(report.capabilities.networkRestriction, 'unsupported');
});

test('[T15] what a version does not list is unsupported, and a fork with no boundary is no fork at a turn', async (t) => {
  const report = await probe(t, { noLastTurnId: true, without: ['thread/resume', 'turn/interrupt', 'thread/read', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'command/exec'] });
  assert.equal(report.capabilities.resume, 'unsupported');
  assert.equal(report.capabilities.cancel, 'unsupported');
  assert.equal(report.capabilities.observeState, 'unsupported');
  assert.equal(report.capabilities.approvals, 'unsupported');
  assert.equal(report.capabilities.forkAtCompletedTurn, 'unsupported');
  assert.equal(report.capabilities.readOnlyRoots, 'unknown', 'what could not be tried is not known');
  assert.equal(report.capabilities.networkRestriction, 'unknown');
});

test('[T15] a version with no schema to read: nothing is claimed', async (t) => {
  const report = await probe(t, { noSchema: true });
  assert.equal(report.binaryVersion, '9.9.9-synthetic');
  for (const name of ['fresh', 'resume', 'forkAtCompletedTurn', 'observeState', 'cancel', 'approvals']) assert.equal(report.capabilities[name], 'unknown', name);
});

test('[T15] a binary that cannot be run: every capability unknown, no version, and no throw', async () => {
  const report = await probeCodex(path.join(fake.bin, 'no-such-codex'));
  assert.equal(report.binaryVersion, null);
  assert.ok(Object.values(report.capabilities).every((c) => c === 'unknown'));
});

test('[T15] the probe keeps away from the person\'s login and history: every process it starts has a home of its own, and it leaves none behind', async (t) => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tdag-codex-probe-')));
  await probe(t, { sandbox: { read: 'closed', network: 'closed' } });
  const started = fake.read('codex').filter((r) => r.kind === 'argv' && r.argv[0] === 'app-server');
  assert.ok(started.length >= 2);
  const realHome = process.env.CODEX_HOME;
  for (const r of started) assert.notEqual(r.codexHome, realHome);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tdag-codex-probe-') && !before.has(n));
  assert.deepEqual(after, []);
  assert.deepEqual(fake.read('codex').filter((r) => r.kind === 'in' && ['thread/start', 'turn/start', 'thread/resume', 'thread/fork'].includes(r.msg.method)), [], 'no thread and no turn: nothing that reaches a model');
});

test('[T15] a runtime keeps its report while its version stands, and asks again when the version changes', async (t) => {
  const codex = fresh(t, { sandbox: { read: 'closed', network: 'closed' } });
  const first = await codex.capabilities();
  const probes = () => fake.read('codex').filter((r) => r.argv?.[1] === 'generate-json-schema').length;
  assert.equal(probes(), 1);
  assert.deepEqual(await codex.capabilities(), first);
  assert.equal(probes(), 1);
  fake.script({ version: '9.9.10-synthetic', sandbox: { read: 'open', network: 'closed' } });
  const again = await codex.capabilities();
  assert.equal(probes(), 2);
  assert.equal(again.binaryVersion, '9.9.10-synthetic');
  assert.equal(again.capabilities.readOnlyRoots, 'unsupported');
});

test('[T15] a runtime that is not installed reports nothing', async (t) => {
  const codex = fresh(t, {}, { find: async () => ({ path: null, searched: [] }) });
  assert.equal(await codex.capabilities(), null);
});

// ── what the host does with the report ──

const researchEnvelope = () => ({
  runId: 'run_t15', mode: 'research', runtime: { kind: 'agent', runtime: 'codex' },
  policy: { read: { scope: 'inputs-only' }, write: { scope: 'none' }, tools: { allow: [], mcpServers: [] }, network: 'off', recall: 'off' },
  inputs: [], messages: [],
});

test('[T15] the host refuses research on what the report does not support', async () => {
  const cwd = fs.mkdtempSync(path.join(fake.project, 'run-'));
  const none = await materializeRun(cwd, researchEnvelope(), {});
  assert.equal(none.ok, false);
  assert.equal(none.code, 'policy');
  const partly = await materializeRun(cwd, researchEnvelope(), {}, {}, { runtime: 'codex', capabilities: { readOnlyRoots: 'unsupported', networkRestriction: 'supported', autoContextControl: 'supported' } });
  assert.equal(partly.ok, false);
  assert.deepEqual(partly.blocked, ['readOnlyRoots']);
});
