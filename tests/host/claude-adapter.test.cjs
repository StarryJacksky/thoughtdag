// What the Claude Code adapter promises (T16), against a stand-in that fails the
// way the real CLI was seen to fail. A new session carries nothing of an old one;
// a branch says it keeps the whole history; what the installed version does not
// list is not sent; what cannot be done is said. Nothing here talks to a real
// CLI, a real login or a real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installFakeRuntimes, runToEnd } = require('../helpers/fake-runtimes.cjs');

const fake = installFakeRuntimes();
const { createClaudeRuntime } = require('../../runtime/agents/claude.cjs');
const { probeClaude } = require('../../runtime/agents/claude-capabilities.cjs');

const SESSION = '11111111-2222-4333-8444-555555555555';
const FILE = path.join(fake.home, '.claude', 'projects', 'synthetic', `${SESSION}.jsonl`);
const MODEL = { provider: 'claude-code', id: 'sonnet' };
const SUPPORTED = { readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'supported' };
const verified = async () => ({ runtime: 'claude-code', binaryVersion: '9.9.9-synthetic', probedAt: 'now', capabilities: SUPPORTED });

test.after(() => fake.cleanup());
function fresh(t, script = {}, options = {}) {
  fake.clear();
  fake.script(script);
  const claude = createClaudeRuntime(options);
  t.after(() => claude.shutdown());
  return claude;
}
const launched = () => fake.read('claude').filter((r) => r.kind === 'argv' && !r.argv.includes('--help') && !r.argv.includes('--version') && !r.argv.includes('--bare'));
const argvOf = () => { const all = launched(); assert.equal(all.length, 1); return all[0].argv; };
const sent = () => fake.read('claude').filter((r) => r.kind === 'in').map((r) => r.msg);
const errorOf = (events) => events.find((e) => e.type === 'run_error');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const go = (claude, req) => runToEnd(claude, { runtime: 'claude-code', cwd: fake.project, prompt: 'hello', model: MODEL, ...req });
const until = async (check, ms = 5000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > ms) throw new Error('it did not come to that'); await pause(10); } };
async function under(claude, req) {
  const events = [];
  let ended; const end = new Promise((resolve) => { ended = resolve; });
  const runId = await claude.run({ runtime: 'claude-code', cwd: fake.project, model: MODEL, ...req }, ({ event }) => { events.push(event); if (event.type === 'run_end') ended(); });
  return { runId, events, end };
}

test('[T16] a new session carries nothing of an old one: no resume, no fork, even when asked at a turn with no session', async (t) => {
  const claude = fresh(t);
  await go(claude, { forkEntryId: 'entry-1' });
  const argv = argvOf();
  assert.equal(argv.includes('--resume'), false);
  assert.equal(argv.includes('--fork-session'), false);
});

test('[T16] going on names the session, and does not branch it', async (t) => {
  const claude = fresh(t);
  const events = await go(claude, { sessionPath: FILE });
  const argv = argvOf();
  assert.equal(argv[argv.indexOf('--resume') + 1], SESSION);
  assert.equal(argv.includes('--fork-session'), false);
  assert.equal(events.at(-1).how, 'end');
});

test('[T16] a branch is asked for as what it is, and says it keeps all of the history it came from', async (t) => {
  const claude = fresh(t);
  const events = await go(claude, { sessionPath: FILE, forkSession: true });
  const argv = argvOf();
  assert.equal(argv[argv.indexOf('--resume') + 1], SESSION);
  assert.equal(argv.includes('--fork-session'), true);
  const binding = events.find((e) => e.type === 'binding');
  assert.equal(binding.inheritsHistory, true);
  assert.notEqual(binding.nativeSessionId, SESSION);
});

test('[T16] a branch at a turn cannot be had: it is refused, and not turned into a copy of the whole history', async (t) => {
  const claude = fresh(t);
  const events = await go(claude, { sessionPath: FILE, forkEntryId: 'entry-7' });
  assert.equal(errorOf(events).code, 'fork-unsupported');
  assert.deepEqual(launched(), []);
  assert.equal(events.at(-1).how, 'error');
});

test('[T16] a flag this version does not list is not sent', async (t) => {
  const claude = fresh(t, { without: ['--effort', '--include-partial-messages'] });
  const events = await go(claude, { effort: 'high' });
  const argv = argvOf();
  assert.equal(argv.includes('--effort'), false);
  assert.equal(argv.includes('--include-partial-messages'), false);
  assert.equal(events.at(-1).how, 'end');
});

test('[T16] a level this version does not list is not sent', async (t) => {
  const claude = fresh(t);
  await go(claude, { effort: 'unheard-of' });
  assert.equal(argvOf().includes('--effort'), false);
});

test('[T16] a version without what a run cannot do without is not started', async (t) => {
  const claude = fresh(t, { without: ['--input-format'] });
  const events = await go(claude, {});
  assert.equal(errorOf(events).code, 'cli-unsupported');
  assert.deepEqual(launched(), []);
});

test('[T16] with no help to read, only what a run cannot do without is sent', async (t) => {
  const claude = fresh(t, { noHelp: true });
  const events = await go(claude, { effort: 'high' });
  const argv = argvOf();
  assert.equal(argv.includes('--effort'), false);
  assert.equal(argv.includes('--include-partial-messages'), false);
  assert.equal(events.at(-1).how, 'end');
});

test('[T16] a path and a prompt that a shell would mangle arrive as they are', async (t) => {
  const claude = fresh(t);
  const odd = path.join(fake.project, `we"ird $(touch ${path.join(fake.root, 'pwned')}) 'dir`);
  const PROMPT = 'PROMPT "quotes", $(echo not-run) and `backticks`\nsecond line';
  await go(claude, { cwd: odd, prompt: PROMPT });
  assert.equal(launched()[0].cwd, fs.realpathSync(odd));
  assert.deepEqual(sent(), [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } }]);
  assert.equal(fs.existsSync(path.join(fake.root, 'pwned')), false);
});

test('[T16] an image is given as data, beside the words', async (t) => {
  const claude = fresh(t);
  await go(claude, { images: [{ type: 'image', data: 'AQIDBA==', mimeType: 'image/png' }] });
  assert.deepEqual(sent()[0].message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' } });
});

test('[T16] a turn that failed is a failure, whatever its subtype says: what it said is not kept as an answer', async (t) => {
  const claude = fresh(t, { failure: 'Not logged in · Please run /login' });
  const events = await go(claude, {});
  assert.equal(errorOf(events).message, 'Not logged in · Please run /login');
  assert.equal(events.at(-1).how, 'error');
  assert.equal(events.at(-1).text, '', 'the failure is not given as the answer');
  assert.equal(events.find((e) => e.type === 'binding').turnStatus, 'failed');
  assert.equal(events.find((e) => e.type === 'binding').lastCompletedTurnId, null);
});

test('[T16] a session that is not there is said as that, and no new one is started instead', async (t) => {
  const claude = fresh(t, { missing: true });
  const events = await go(claude, { sessionPath: FILE });
  assert.equal(errorOf(events).code, 'session-missing');
  assert.equal(launched().length, 1);
  assert.equal(events.at(-1).how, 'error');
});

test('[T16] a session in use elsewhere is said as that, and no new one is started instead', async (t) => {
  const claude = fresh(t, { busy: true });
  const events = await go(claude, { sessionPath: FILE });
  assert.equal(errorOf(events).code, 'session-busy');
  assert.equal(launched().length, 1);
  assert.equal(events.at(-1).how, 'error');
});

test('[T16] a run that finished answers with its session and its last entry', async (t) => {
  const claude = fresh(t);
  const events = await go(claude, {});
  const binding = events.find((e) => e.type === 'binding');
  assert.equal(binding.nativeSessionId, events.find((e) => e.type === 'session').sessionId);
  assert.equal(binding.lastCompletedTurnId, 'assistant-entry-1');
  assert.equal(binding.turnStatus, 'completed');
  assert.equal(binding.inheritsHistory, false);
});

test('[T16][L01] stopped before the process has started: it never starts, and the prompt is never sent', async (t) => {
  const claude = fresh(t);
  const run = await under(claude, { prompt: 'PROMPT_NOT_TO_BE_SENT' });
  assert.equal(claude.abort(run.runId), true);
  await run.end;
  assert.deepEqual(launched(), []);
  assert.equal(run.events.at(-1).how, 'aborted');
  assert.equal(errorOf(run.events), undefined);
});

test('[T16] stopped while it works: the process ends, and the run says stopped, with no turn called finished', async (t) => {
  const claude = fresh(t, { hold: true });
  const run = await under(claude, { prompt: 'long' });
  await until(() => run.events.some((e) => e.type === 'session'));
  assert.equal(claude.abort(run.runId), true);
  await run.end;
  assert.equal(run.events.at(-1).how, 'aborted');
  const binding = run.events.find((e) => e.type === 'binding');
  assert.equal(binding.lastCompletedTurnId, null);
  assert.equal(binding.turnStatus, 'interrupted');
});

test('[T16] research on a version not known to keep to its inputs is not run at all', async (t) => {
  const claude = fresh(t);
  const events = await go(claude, { mode: 'research' });
  assert.equal(errorOf(events).code, 'research-unverified');
  assert.deepEqual(launched(), []);
});

const materialsOf = (dir) => { fs.mkdirSync(path.join(fake.project, dir), { recursive: true }); return dir; };

test('[T16] research runs in its own materials and nowhere above them: that folder is all its file tools reach', async (t) => {
  const claude = fresh(t, {}, { probe: verified });
  const readRoot = materialsOf('.thoughtdag/runs/run_a/materials');
  const events = await go(claude, { mode: 'research', readRoot });
  assert.equal(events.at(-1).how, 'end');
  assert.equal(launched()[0].cwd, fs.realpathSync(path.join(fake.project, readRoot)));
});

test('[T16] research with nothing to read runs in an empty folder of its own, which it leaves behind it', async (t) => {
  const claude = fresh(t, {}, { probe: verified });
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tdag-research-')));
  const events = await go(claude, { mode: 'research' });
  assert.equal(events.at(-1).how, 'end');
  const cwd = launched()[0].cwd;
  assert.notEqual(cwd, fs.realpathSync(fake.project));
  assert.match(path.basename(cwd), /^tdag-research-/);
  await until(() => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tdag-research-') && !before.has(n)).length === 0);
});

for (const [name, readRoot] of [['above the folder', '../elsewhere'], ['an absolute path', '/synthetic/elsewhere'], ['not there', '.thoughtdag/runs/run_none/materials'], ['the folder itself', '.']]) {
  test(`[T16] research told to read ${name} is not run`, async (t) => {
    const claude = fresh(t, {}, { probe: verified });
    const events = await go(claude, { mode: 'research', readRoot });
    assert.equal(errorOf(events).code, 'research-unverified');
    assert.deepEqual(launched(), []);
  });
}

test('[T16] a run at work stays in its folder, whatever else it is told', async (t) => {
  const claude = fresh(t);
  await go(claude, { readRoot: materialsOf('.thoughtdag/runs/run_b/materials') });
  assert.equal(launched()[0].cwd, fs.realpathSync(fake.project));
});

test('[T16] research goes on in no session, whatever it was given', async (t) => {
  const claude = fresh(t, {}, { probe: verified });
  const events = await go(claude, { mode: 'research', sessionPath: FILE });
  assert.equal(errorOf(events).code, 'research-unverified');
  assert.deepEqual(launched(), []);
});

test('[T16] research on a version known to keep to its inputs gets reading tools only, no settings of the person\'s, and nobody to ask', async (t) => {
  const claude = fresh(t, {}, { probe: verified });
  const events = await go(claude, { mode: 'research' });
  const argv = argvOf();
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  for (const flag of ['--restricted', '--safe-mode', '--strict-mcp-config']) assert.equal(argv.includes(flag), true, flag);
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  // the default system prompt says who the person is and what the machine is
  assert.match(argv[argv.indexOf('--system-prompt') + 1], /inputs/);
  assert.equal(argv.includes('--resume'), false);
  assert.equal(events.at(-1).how, 'end');
});

test('[T16] research whose process comes up with more tools than it was given is stopped at once, and said', async (t) => {
  const claude = fresh(t, { tools: ['Read', 'Bash'], hold: true }, { probe: verified });
  const events = await go(claude, { mode: 'research' });
  assert.equal(errorOf(events).code, 'research-unverified');
  assert.equal(events.at(-1).how, 'error');
});

const SESSION_OF_THE_HOST = {
  CLAUDECODE: '1', CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_SESSION_ID: 'the-host-session', CLAUDE_CODE_MESSAGING_SOCKET: '/synthetic/socket', CLAUDE_CODE_MESSAGING_TOKEN: 'synthetic',
  CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/host-proxy',
};
const withEnv = async (t, env) => { const saved = {}; for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }); };

test('[T16] started from inside another Claude Code session, a run is its own: nothing of that session comes along', async (t) => {
  await withEnv(t, { ...SESSION_OF_THE_HOST, CLAUDE_CODE_OAUTH_TOKEN: 'a-token-of-the-person', CLAUDE_CONFIG_DIR: path.join(fake.home, '.claude') });
  const claude = fresh(t);
  await go(claude, {});
  const { env } = launched()[0];
  for (const name of Object.keys(SESSION_OF_THE_HOST)) assert.equal(env.includes(name), false, name);
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) assert.equal(env.includes(name), true, `${name}: the way the person signs in stays`);
});

test('[T16] started from anywhere else, what the person set stays', async (t) => {
  await withEnv(t, { CLAUDECODE: undefined, ANTHROPIC_BASE_URL: 'https://synthetic.example/their-gateway' });
  const claude = fresh(t);
  await go(claude, {});
  assert.equal(launched()[0].env.includes('ANTHROPIC_BASE_URL'), true);
});

test('[T16] the probe, too, is not of the session it was started in', async (t) => {
  await withEnv(t, SESSION_OF_THE_HOST);
  fake.clear();
  fake.script({});
  await probeClaude(path.join(fake.bin, 'claude'));
  const tried = fake.read('claude').find((r) => r.kind === 'argv' && r.argv.includes('--tools'));
  for (const name of Object.keys(SESSION_OF_THE_HOST)) assert.equal(tried.env.includes(name), false, name);
});

test('[T16] the binary a desktop app brings with it is found, the newest of them, after whatever is on the path', async () => {
  const { locate } = require('../../runtime/agents/where.cjs');
  const { claudeAppDirs } = require('../../runtime/agents/claude.cjs');
  const root = path.join(fake.root, 'app-home', 'Library', 'Application Support', 'Claude', 'claude-code');
  const at = (version, hash) => path.join(root, version, hash, 'claude.app', 'Contents', 'MacOS');
  for (const [v, h] of [['2.1.9', 'aaa'], ['2.1.10', 'bbb']]) { fs.mkdirSync(at(v, h), { recursive: true }); fs.writeFileSync(path.join(at(v, h), 'claude-only-in-app'), '#!/bin/sh\n'); fs.chmodSync(path.join(at(v, h), 'claude-only-in-app'), 0o755); }
  const found = await locate('claude-only-in-app', claudeAppDirs(path.join(fake.root, 'app-home')));
  assert.equal(found.path, path.join(at('2.1.10', 'bbb'), 'claude-only-in-app'));
  assert.deepEqual(claudeAppDirs(path.join(fake.root, 'no-such-home')), []);
});

// ── the probe ──

async function probe(script) {
  fake.clear();
  fake.script(script);
  return probeClaude(path.join(fake.bin, 'claude'));
}

test('[T16] the probe reports what this version can do, and its version', async () => {
  const report = await probe({});
  assert.equal(report.runtime, 'claude-code');
  assert.equal(report.binaryVersion, '9.9.9-synthetic');
  assert.ok(Date.parse(report.probedAt));
  assert.deepEqual(report.capabilities, {
    fresh: 'supported', resume: 'supported', forkAtCompletedTurn: 'unsupported', observeState: 'unsupported', cancel: 'supported', approvals: 'supported',
    readOnlyRoots: 'unknown', networkRestriction: 'supported', autoContextControl: 'unknown',
  });
});

test('[T16] what real runs have shown of a version is known of that version, and of no other', async () => {
  const { VERIFIED_BY_RUNNING } = require('../../runtime/agents/claude-capabilities.cjs');
  const version = Object.keys(VERIFIED_BY_RUNNING)[0];
  const shown = await probe({ version });
  assert.equal(shown.capabilities.readOnlyRoots, 'supported');
  assert.equal(shown.capabilities.autoContextControl, 'unsupported', 'the account\'s email comes along, whatever the system prompt');
  const other = await probe({ version: '0.0.1-never-run' });
  assert.equal(other.capabilities.readOnlyRoots, 'unknown');
  assert.equal(other.capabilities.autoContextControl, 'unknown');
});

test('[T16] a version that comes up with more tools than it was given is not called offline', async () => {
  const report = await probe({ tools: ['Read', 'WebFetch'] });
  assert.equal(report.capabilities.networkRestriction, 'unsupported');
});

test('[T16] what a version does not list is unsupported', async () => {
  const report = await probe({ without: ['--resume', '--input-format', '--permission-prompts'], help: undefined });
  assert.equal(report.capabilities.resume, 'unsupported');
  assert.equal(report.capabilities.fresh, 'unsupported');
  assert.equal(report.capabilities.approvals, 'unsupported');
});

test('[T16] no help to read: nothing is claimed, and a version is still given', async () => {
  const report = await probe({ noHelp: true });
  assert.equal(report.binaryVersion, '9.9.9-synthetic');
  for (const name of ['fresh', 'resume', 'approvals', 'readOnlyRoots', 'networkRestriction', 'autoContextControl']) assert.equal(report.capabilities[name], 'unknown', name);
});

test('[T16] a binary that cannot be run: every capability unknown, no version, and no throw', async () => {
  const report = await probeClaude(path.join(fake.bin, 'no-such-claude'));
  assert.equal(report.binaryVersion, null);
  assert.ok(Object.values(report.capabilities).every((c) => c === 'unknown'));
});

test('[T16] the probe keeps away from the person\'s login and history: a home of its own, the mode that reads no login, and it leaves nothing behind', async () => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tdag-claude-probe-')));
  await probe({});
  const tried = fake.read('claude').filter((r) => r.kind === 'argv' && r.argv.includes('--tools'));
  assert.equal(tried.length, 1);
  assert.equal(tried[0].argv.includes('--bare'), true);
  assert.notEqual(tried[0].home, process.env.HOME);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('tdag-claude-probe-') && !before.has(n)), []);
});

test('[T16] a runtime keeps its report while its version stands, and asks again when the version changes', async (t) => {
  const claude = fresh(t);
  const first = await claude.capabilities();
  const tries = () => fake.read('claude').filter((r) => r.argv?.includes('--tools')).length;
  assert.equal(tries(), 1);
  assert.deepEqual(await claude.capabilities(), first);
  assert.equal(tries(), 1);
  fake.script({ version: '9.9.10-synthetic' });
  assert.equal((await claude.capabilities()).binaryVersion, '9.9.10-synthetic');
  assert.equal(tries(), 2);
});

test('[T16] a runtime that is not installed reports nothing', async (t) => {
  const claude = fresh(t, {}, { find: async () => ({ path: null, searched: [] }) });
  assert.equal(await claude.capabilities(), null);
});
