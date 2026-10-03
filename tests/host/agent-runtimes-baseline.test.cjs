// The Codex and Claude Code host adapters as they stand, driven against the
// capturing fakes: what each one sends its CLI for a fresh, a continued and a
// branched turn, and what an agent in that working directory can read. These
// are the facts later tasks (routing, materialization, the adapters' own
// hardening) start from; nothing here talks to a real CLI or a real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakeRuntimes, runToEnd } = require('../helpers/fake-runtimes.cjs');

// before the runtimes load: they read HOME and cache the binary they find
const fake = installFakeRuntimes();
const { createCodexRuntime } = require('../../runtime/agents/codex.cjs');
const { createClaudeRuntime } = require('../../runtime/agents/claude.cjs');

const codex = createCodexRuntime();
const claude = createClaudeRuntime();
test.after(() => { codex.shutdown(); claude.shutdown(); fake.cleanup(); });

const SESSION = '11111111-2222-4333-8444-555555555555';
// a shell would mangle this; passed as data it must arrive untouched
const PROMPT = 'PROMPT_MARK_Z1 with "quotes", $(echo not-run) and `backticks`\nsecond line';
const received = (runtime) => fake.read(runtime).filter((r) => r.kind === 'in').map((r) => r.msg);
const types = (events) => events.map((e) => e.type);

test('codex: the lookup finds the fake, and the catalog opens with the handshake', async () => {
  assert.equal(await codex.available(), path.join(fake.bin, 'codex'));
  const catalog = await codex.models();
  assert.equal(catalog.installed, true);
  assert.deepEqual(catalog.models.map((m) => m.id), ['gpt-synthetic']);
  assert.equal(catalog.default, 'codex/gpt-synthetic');
  assert.deepEqual(fake.read('codex').find((r) => r.kind === 'argv').argv, ['app-server']);
  assert.deepEqual(received('codex').map((m) => m.method), ['initialize', 'initialized', 'model/list']);
});

test('codex: a fresh run starts a thread in the working directory and sends the prompt as data', async () => {
  fake.clear();
  const events = await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: PROMPT, model: { provider: 'codex', id: 'gpt-synthetic' } });
  const msgs = received('codex');
  assert.deepEqual(msgs.map((m) => m.method), ['thread/start', 'turn/start']);
  assert.deepEqual(msgs[0].params, { cwd: fake.project, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'gpt-synthetic' });
  assert.deepEqual(msgs[1].params.input, [{ type: 'text', text: PROMPT, text_elements: [] }]);
  assert.ok(types(events).includes('session'));
  assert.ok(types(events).includes('message_update'));
  const session = events.find((e) => e.type === 'session');
  assert.equal(session.sessionId, msgs[1].params.threadId);
  assert.equal(path.dirname(session.sessionFile), fake.sessions);
  assert.deepEqual(events.at(-1), { type: 'run_end', text: 'synthetic codex answer', how: 'end' });
});

test('codex: a run given a session file resumes that thread', async () => {
  fake.clear();
  await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'continue', sessionPath: path.join(fake.sessions, `rollout-${SESSION}.jsonl`), model: { provider: 'codex', id: 'gpt-synthetic' } });
  const msgs = received('codex');
  assert.deepEqual(msgs.map((m) => m.method), ['thread/resume', 'turn/start']);
  assert.equal(msgs[0].params.threadId, SESSION);
});

// Today's behavior, on record: the fork names the thread and nothing else, so
// the branch inherits the whole history. The entry the canvas asked to fork
// at does not travel. The plan's T15 revisits this against what the
// installed CLI supports.
test('codex: a fork names the thread only; no turn boundary travels', async () => {
  fake.clear();
  await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'branch', sessionPath: path.join(fake.sessions, `rollout-${SESSION}.jsonl`), forkEntryId: 'entry-7', model: { provider: 'codex', id: 'gpt-synthetic' } });
  const fork = received('codex')[0];
  assert.equal(fork.method, 'thread/fork');
  assert.deepEqual(Object.keys(fork.params).sort(), ['approvalPolicy', 'cwd', 'model', 'sandbox', 'threadId']);
  assert.equal(fork.params.threadId, SESSION);
});

test('codex: the agent can read exactly the materials written under the working directory', async () => {
  fake.clear();
  fake.writeMaterial('sampling-plan.md', 'KEEP_VISIBLE_P2: sample 40 sites.');
  await runToEnd(codex, { runtime: 'codex', cwd: fake.project, prompt: 'read the plan', model: { provider: 'codex', id: 'gpt-synthetic' } });
  const readable = fake.read('codex').find((r) => r.kind === 'readable');
  assert.deepEqual(readable.files, [{ path: 'sampling-plan.md', content: 'KEEP_VISIBLE_P2: sample 40 sites.' }]);
});

test('codex: a thread busy elsewhere ends the run with the server\'s reason, not a silent retry', async (t) => {
  // a runtime of its own: its server starts now and reads the script. (Stopping
  // the shared one and running again at once is not safe today: the stopped
  // server's exit event lands on its successor and orphans it.)
  fake.script({ busyThreads: [SESSION] });
  const busyCodex = createCodexRuntime();
  t.after(() => busyCodex.shutdown());
  fake.clear();
  const events = await runToEnd(busyCodex, { runtime: 'codex', cwd: fake.project, prompt: 'continue', sessionPath: path.join(fake.sessions, `rollout-${SESSION}.jsonl`), model: { provider: 'codex', id: 'gpt-synthetic' } });
  fake.script(null);
  assert.deepEqual(events.find((e) => e.type === 'run_error'), { type: 'run_error', message: 'thread is busy in another client' });
  assert.equal(events.at(-1).how, 'error');
  assert.deepEqual(received('codex').filter((m) => m.method === 'thread/resume').length, 1);
  assert.ok(!received('codex').some((m) => m.method === 'thread/start' || m.method === 'turn/start'));
});

test('claude: the lookup finds the fake, and the efforts come from its own --help', async () => {
  assert.equal(await claude.available(), path.join(fake.bin, 'claude'));
  const catalog = await claude.models();
  assert.equal(catalog.installed, true);
  assert.deepEqual(catalog.models[0].efforts, ['low', 'medium', 'high']);
});

test('claude: a fresh run passes its flags as arguments and the prompt as one stdin message', async () => {
  fake.clear();
  const events = await runToEnd(claude, { runtime: 'claude-code', cwd: fake.project, prompt: PROMPT, model: { provider: 'claude-code', id: 'sonnet' } });
  const launched = fake.read('claude').find((r) => r.kind === 'argv');
  assert.deepEqual(launched.argv, ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'default', '--permission-prompt-tool', 'stdio', '--model', 'sonnet']);
  assert.equal(launched.cwd, fs.realpathSync(fake.project));
  assert.deepEqual(received('claude'), [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } }]);
  assert.ok(types(events).includes('session'));
  assert.ok(types(events).includes('message_update'));
  assert.deepEqual(events.at(-1), { type: 'run_end', text: 'synthetic claude answer', how: 'end' });
});

test('claude: a run given a session file resumes it; a fork adds --fork-session', async () => {
  const sessionPath = path.join(fake.home, '.claude', 'projects', 'synthetic', `${SESSION}.jsonl`);
  fake.clear();
  const resumed = await runToEnd(claude, { runtime: 'claude-code', cwd: fake.project, prompt: 'continue', sessionPath, model: { provider: 'claude-code', id: 'sonnet' } });
  const resumeArgv = fake.read('claude').find((r) => r.kind === 'argv').argv;
  assert.deepEqual(resumeArgv.slice(-2), ['--resume', SESSION]);
  assert.equal(resumed.find((e) => e.type === 'session').sessionId, SESSION);

  fake.clear();
  const forked = await runToEnd(claude, { runtime: 'claude-code', cwd: fake.project, prompt: 'branch', sessionPath, forkEntryId: 'entry-7', model: { provider: 'claude-code', id: 'sonnet' } });
  const forkArgv = fake.read('claude').find((r) => r.kind === 'argv').argv;
  assert.deepEqual(forkArgv.slice(-3), ['--resume', SESSION, '--fork-session']);
  assert.notEqual(forked.find((e) => e.type === 'session').sessionId, SESSION);
});

test('claude: the agent can read exactly the materials written under the working directory', async () => {
  fake.clear();
  await runToEnd(claude, { runtime: 'claude-code', cwd: fake.project, prompt: 'read the plan', model: { provider: 'claude-code', id: 'sonnet' } });
  const readable = fake.read('claude').find((r) => r.kind === 'readable');
  assert.deepEqual(readable.files, [{ path: 'sampling-plan.md', content: 'KEEP_VISIBLE_P2: sample 40 sites.' }]);
});
