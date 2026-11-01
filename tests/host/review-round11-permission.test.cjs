// R11-02 of the review of c440c81: a canvas that had left was only noticed by
// a poll every 500 ms, and until then its queued message entering a turn still
// switched the session to the canvas's permission mode. The plugin as shipped
// (dsh/lib/index.js) runs on a stand-in harness over real HTTP, so the response
// really closes; the clock of that poll is virtual and only moves when a test
// says so. The last tests load the plugin's own functions into a VM for a
// caller that can only be asked whether it has left. Nothing here touches a
// real project or a real agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const { mock } = test;

/** Everything already able to run has run: promises, and I/O that has arrived. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
const clock = (ms) => { if (ms > 0) mock.timers.tick(ms); return settle(); };
const soon = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// a turn the plugin waits for is bounded by a 20-minute timer it does not clear: let it not keep the test process alive
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, ms, ...args) {
  const timer = realSetTimeout(fn, ms, ...args);
  if (typeof ms === 'number' && ms >= 60_000) timer.unref?.();
  return timer;
};

const PRESETS = ['read-only', 'workspace-write', 'auto', 'danger-full-access'];
const WANT = { allow: 'danger-full-access', auto: 'auto' };
let harness = null;

async function standIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-r11-plugin-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'dsh', 'lib', 'index.js'), path.join(dir, 'lib', 'index.js'));
  fs.cpSync(path.join(ROOT, 'runtime'), path.join(dir, 'lib', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-thoughtdag', version: '0.0.0-test', type: 'module' }));

  const listeners = new Map();
  const on = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  };
  const emitEvent = (name, ...args) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); };
  const sessions = new Map();
  const preset = new Map();
  const applied = [];
  const prompts = [];
  const cancels = [];
  const refuse = new Set();
  const holds = { prompt: null };
  const presets = {
    names: PRESETS,
    current: (session) => preset.get(session.id),
    apply: (session, name, setPolicy) => { preset.set(session.id, name); applied.push(`${session.id}:${name}`); setPolicy({ preset: name }); },
  };
  const agentOf = (id) => ({ id, session: sessions.get(id), inject: () => {}, whenIdle: () => new Promise(() => {}), cancel: () => cancels.push(id) });
  let api = null;
  const ctx = {
    effect: (fn) => fn(),
    inject: (deps, fn) => { if (deps.includes('permissionPresets')) fn({ permissionPresets: presets, effect: () => {} }); },
    on,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    webServer: { register: ({ path: at, handler }) => { if (at.endsWith('/api')) api = handler; return () => {}; } },
    sessions: { get: (id) => sessions.get(id) },
    agents: { get: (id) => (sessions.has(id) ? agentOf(id) : undefined) },
    approval: { setPolicy: () => {} },
    sessionController: {
      prompt: async (req) => {
        prompts.push(req);
        if (holds.prompt) await holds.prompt;
        if (refuse.has(req.sessionId)) throw new Error('the session would not take the message');
      },
      selectModel: async () => {},
      modelCatalog: async () => ({ groups: [] }),
      resolveAgent: async (id) => ({ agent: agentOf(id) }),
      create: async () => { throw new Error('not in these tests'); },
      fork: async () => { throw new Error('not in these tests'); },
    },
  };
  const plugin = await import(pathToFileURL(path.join(dir, 'lib', 'index.js')).href);
  await plugin.apply(ctx, { whyTools: false, whyPrompt: false });
  /** the tag of an asking request → told once the plugin has heard its response close */
  const closeHeard = new Map();
  const server = http.createServer((req, res) => {
    res.on('close', () => setImmediate(() => closeHeard.get(req.headers['x-ask'])?.()));
    api(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let seq = 0;
  let asks = 0;
  const event = (id, type, data) => emitEvent('session/event', sessions.get(id), { type, data, seq: ++seq });
  return {
    dir, server, preset, applied, prompts, cancels, refuse, holds,
    session(id, setting = 'workspace-write') { sessions.set(id, { id }); preset.set(id, setting); },
    /** How many subscriptions the plugin holds on the harness right now. */
    subscribed: () => (listeners.get('session/event')?.size ?? 0) + (listeners.get('agent/assistant-stream')?.size ?? 0),
    /** Ask on the canvas, continuing session `id` in permission `mode`. `leave` resolves once the plugin has heard the response close. */
    ask(id, mode) {
      const tag = String(++asks);
      const heard = new Promise((resolve) => closeHeard.set(tag, resolve));
      const leaving = new AbortController();
      const done = fetch(`http://127.0.0.1:${port}/thoughtdag/api/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ask': tag },
        body: JSON.stringify({ model: 'harness/agent', messages: [{ role: 'user', content: `a question in ${mode}` }], harness: { session: id, permission: mode } }),
        signal: leaving.signal,
      }).then((r) => r.text()).then((text) => text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6))), () => 'left');
      return { done, leave: async () => { leaving.abort(); await done; await heard; } };
    },
    async promptCount(n) {
      for (let i = 0; i < 400 && prompts.length < n; i++) await soon();
      assert.equal(prompts.length, n, `${n} prompts reached the session`);
      await settle(); // and the plugin is now waiting for its turn
    },
    turnStarts(id, turn) { event(id, 'turn/start', { turn }); },
    entersTurn(id, index) { event(id, 'user/message', { id: `msg-${index}`, source: { kind: 'user', rpcId: prompts[index].requestId } }); },
    turnEnds(id, turn) { event(id, 'turn/end', { turn }); },
  };
}

test.before(async () => { harness = await standIn(); });
test.after(() => { harness?.server.closeAllConnections(); harness?.server.close(); if (harness) fs.rmSync(harness.dir, { recursive: true, force: true }); });
test.beforeEach(() => { mock.timers.enable({ apis: ['setInterval'] }); });
test.afterEach(() => { mock.timers.reset(); harness.holds.prompt = null; });

let sessions = 0;
const newSession = (setting) => { const id = `R11-${++sessions}`; harness.session(id, setting); return id; };

// ── the message of a canvas that left, entering a turn at any moment around the poll ──

// [name, clock moved before the canvas leaves, clock moved after it leaves, before the message enters]
const MOMENTS = [
  ['right after it left', 0, 0],
  ['1 ms before the poll would look', 499, 0],
  ['1 ms after it left', 0, 1],
  ['499 ms after it left', 0, 499],
  ['after the poll would have looked', 0, 500],
];

for (const [when, beforeLeaving, afterLeaving] of MOMENTS) {
  test(`[R11-02] a message left in the queue that enters its turn ${when} gets none of the canvas's permission (turn first, then message)`, async () => {
    const h = harness;
    const id = newSession();
    h.turnStarts(id, 1); // the person's own turn is running
    const before = h.applied.length;
    const at = h.prompts.length;
    const a = h.ask(id, 'allow');
    await h.promptCount(at + 1);
    await clock(beforeLeaving);
    await a.leave();
    await clock(afterLeaving);
    assert.deepEqual(h.cancels.filter((s) => s === id), [], 'the person\'s running turn is not stopped for it');
    h.turnEnds(id, 1);
    h.turnStarts(id, 2);
    h.entersTurn(id, at);
    assert.equal(h.preset.get(id), 'workspace-write', 'the message runs as the person set the session');
    assert.deepEqual(h.applied.slice(before), [], 'the mode was never applied, not even for a moment');
    h.turnEnds(id, 2);
    await clock(500);
    assert.deepEqual(h.applied.slice(before), []);
    assert.deepEqual(h.cancels.filter((s) => s === id), [], 'and a turn nobody waits for is not stopped either (L02)');
  });

  test(`[R11-02] a message left in the queue that enters its turn ${when} gets none of the canvas's permission (message first, then turn)`, async () => {
    const h = harness;
    const id = newSession();
    const before = h.applied.length;
    const at = h.prompts.length;
    const a = h.ask(id, 'allow');
    await h.promptCount(at + 1);
    await clock(beforeLeaving);
    await a.leave();
    await clock(afterLeaving);
    h.entersTurn(id, at);
    h.turnStarts(id, 1);
    assert.equal(h.preset.get(id), 'workspace-write');
    assert.deepEqual(h.applied.slice(before), []);
    h.turnEnds(id, 1);
    assert.deepEqual(h.applied.slice(before), []);
  });
}

// ── the response closing ends the wait itself ──────────────────────────

test('[R11-02] the response closing ends the wait and the subscriptions at once, with the clock standing still', async () => {
  const h = harness;
  const id = newSession();
  h.turnStarts(id, 1);
  const baseline = h.subscribed();
  const at = h.prompts.length;
  const a = h.ask(id, 'allow');
  await h.promptCount(at + 1);
  assert.equal(h.subscribed(), baseline + 2, 'while it waits the plugin follows the session');
  await a.leave();
  assert.equal(h.subscribed(), baseline, 'it no longer does, without the poll having run');
});

test('[R11-02] a canvas that leaves its running turn stops it and puts the session back at once, with the clock standing still', async () => {
  const h = harness;
  const id = newSession();
  const at = h.prompts.length;
  const a = h.ask(id, 'allow');
  await h.promptCount(at + 1);
  h.turnStarts(id, 1);
  h.entersTurn(id, at);
  assert.equal(h.preset.get(id), 'danger-full-access');
  await a.leave();
  assert.deepEqual(h.cancels.filter((s) => s === id), [id], 'its own turn is stopped');
  assert.equal(h.preset.get(id), 'workspace-write', 'and the session is the person\'s again');
});

// ── two requests, different modes ──────────────────────────────────────

for (const [first, second] of [['allow', 'auto'], ['auto', 'allow']]) {
  test(`[R11-02] ${first} running, ${second} queued and left: the running turn is not stopped, and the left message gets no mode`, async () => {
    const h = harness;
    const id = newSession();
    const at = h.prompts.length;
    const a = h.ask(id, first);
    await h.promptCount(at + 1);
    const b = h.ask(id, second);
    await h.promptCount(at + 2);
    h.turnStarts(id, 1);
    h.entersTurn(id, at);
    assert.equal(h.preset.get(id), WANT[first]);
    await b.leave();
    await clock(499);
    assert.equal(h.preset.get(id), WANT[first], 'the first turn keeps its mode');
    assert.deepEqual(h.cancels.filter((s) => s === id), [], 'and is not stopped by the second leaving');
    h.turnEnds(id, 1);
    await a.done;
    assert.equal(h.preset.get(id), 'workspace-write');
    const before = h.applied.length;
    h.turnStarts(id, 2);
    h.entersTurn(id, at + 1);
    assert.equal(h.preset.get(id), 'workspace-write', 'the left message runs as the person set the session');
    assert.deepEqual(h.applied.slice(before), []);
    h.turnEnds(id, 2);
  });

  test(`[R11-02] ${first} running and left, ${second} queued and still waited for: the second turn runs in its own mode, and the session ends as the person set it`, async () => {
    const h = harness;
    const id = newSession();
    const at = h.prompts.length;
    const a = h.ask(id, first);
    await h.promptCount(at + 1);
    const b = h.ask(id, second);
    await h.promptCount(at + 2);
    h.turnStarts(id, 1);
    h.entersTurn(id, at);
    await a.leave();
    assert.equal(h.preset.get(id), 'workspace-write', 'put back as the first canvas leaves');
    assert.deepEqual(h.cancels.filter((s) => s === id), [id]);
    h.turnEnds(id, 1); // the stop took effect
    h.turnStarts(id, 2);
    h.entersTurn(id, at + 1);
    assert.equal(h.preset.get(id), WANT[second], 'the canvas still waiting gets its mode');
    h.turnEnds(id, 2);
    const frames = await b.done;
    assert.deepEqual(frames.filter((f) => f.permission).map((f) => f.permission), [{ mode: second, applied: true }]);
    assert.equal(h.preset.get(id), 'workspace-write');
  });
}

// ── a setting the person changes, and a queue that refuses ─────────────

test('[R11-02] a setting the person picks after the canvas left stays when the left message enters its turn', async () => {
  const h = harness;
  const id = newSession();
  h.turnStarts(id, 1);
  const at = h.prompts.length;
  const a = h.ask(id, 'allow');
  await h.promptCount(at + 1);
  await a.leave();
  h.preset.set(id, 'read-only'); // in the harness's own settings
  const before = h.applied.length;
  h.turnEnds(id, 1);
  h.turnStarts(id, 2);
  h.entersTurn(id, at);
  assert.equal(h.preset.get(id), 'read-only');
  assert.deepEqual(h.applied.slice(before), []);
});

test('[R11-02] a setting the person picks while the canvas\'s turn runs stays when the canvas leaves', async () => {
  const h = harness;
  const id = newSession();
  const at = h.prompts.length;
  const a = h.ask(id, 'allow');
  await h.promptCount(at + 1);
  h.turnStarts(id, 1);
  h.entersTurn(id, at);
  h.preset.set(id, 'read-only');
  const before = h.applied.length;
  await a.leave();
  assert.equal(h.preset.get(id), 'read-only');
  assert.deepEqual(h.applied.slice(before), []);
});

test('[R11-02] a canvas that leaves while its message is being queued, and the queue refuses it: nothing changes and nothing is left subscribed', async () => {
  const h = harness;
  const id = newSession();
  const baseline = h.subscribed();
  h.refuse.add(id);
  let answer = () => {};
  h.holds.prompt = new Promise((resolve) => { answer = resolve; });
  const before = h.applied.length;
  const at = h.prompts.length;
  const a = h.ask(id, 'allow');
  await h.promptCount(at + 1);
  await a.leave();
  answer();
  await settle();
  assert.deepEqual(h.applied.slice(before), []);
  assert.equal(h.preset.get(id), 'workspace-write');
  assert.equal(h.subscribed(), baseline);
});

test('[R11-02] a canvas that leaves while its message is being queued, and the message enters a turn before the queue answers: no mode, and the wait ends as the queue answers', async () => {
  const h = harness;
  const id = newSession();
  const baseline = h.subscribed();
  let answer = () => {};
  h.holds.prompt = new Promise((resolve) => { answer = resolve; });
  const before = h.applied.length;
  const at = h.prompts.length;
  const a = h.ask(id, 'allow');
  await h.promptCount(at + 1);
  await a.leave();
  h.turnStarts(id, 1);
  h.entersTurn(id, at);
  assert.deepEqual(h.applied.slice(before), [], 'the request is checked where the turn is claimed');
  answer();
  await settle();
  assert.equal(h.subscribed(), baseline, 'with the clock standing still');
  assert.deepEqual(h.cancels.filter((s) => s === id), []);
  h.turnEnds(id, 1);
  assert.deepEqual(h.applied.slice(before), []);
});

// ── a caller that can only be asked ────────────────────────────────────
// The plugin's own functions in a VM, on stand-in events and intervals: the
// subscription is still in place here when the message enters its turn, so
// what stops the mode is the check where the turn is claimed.

function probeFixture() {
  const src = fs.readFileSync(path.join(ROOT, 'dsh', 'lib', 'index.js'), 'utf8');
  const start = src.indexOf('const CANVAS_PRESETS');
  const code = src.slice(start, src.indexOf('/** A vision-capable', start));
  let mode = 'workspace-write';
  let closed = false;
  let serial = 0;
  const trace = [];
  const prompts = [];
  const frames = [];
  const listeners = new Map();
  const intervals = new Set();
  const session = { id: 'probe' };
  const agent = { session, whenIdle: () => new Promise(() => {}), cancel: () => trace.push('cancel'), inject() {} };
  const presets = { names: PRESETS, current: () => mode, apply: (_s, name, setPolicy) => { mode = name; trace.push(name); setPolicy({}); } };
  const ctx = {
    approval: { setPolicy() {} },
    on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    sessionController: { prompt: async (req) => prompts.push(req), selectModel: async () => {} },
  };
  const env = {
    module: { exports: {} }, globalPresets: presets,
    compileForAgent: () => ({ question: 'Q', context: '' }), liveSession: () => true, canvasTurns: new Map(), agentOf: async () => agent, agentTargetOf: () => null,
    randomUUID: () => String(++serial), SOURCE: { kind: 'synthetic' }, AbortSignal,
    setTimeout: () => 0, setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn),
  };
  vm.runInNewContext(`${code}\npermissionPresets=globalPresets;module.exports={runAgentTurn};`, env);
  const event = (type, data) => { for (const fn of [...(listeners.get('session/event') ?? [])]) fn(session, { type, data }); };
  return {
    trace, prompts, frames, event,
    mode: () => mode,
    close() { closed = true; },
    poll() { for (const fn of [...intervals]) fn(); },
    run: (permission = 'allow') => env.module.exports.runAgentTurn(ctx, { harness: { session: 'probe', permission } }, (f) => frames.push(f), () => closed),
  };
}
const permissionFrames = (frames) => frames.filter((f) => f.permission).map((f) => f.permission);

test('[R11-02] a caller known to have left before the poll looks: the claim itself refuses the mode (turn first, then message)', async () => {
  const f = probeFixture();
  const run = f.run();
  await settle();
  f.event('turn/start', { turn: 1 });
  f.close();
  f.event('turn/end', { turn: 1 });
  f.event('turn/start', { turn: 2 });
  f.event('user/message', { id: 'm', source: { kind: 'user', rpcId: f.prompts[0].requestId } });
  assert.equal(f.mode(), 'workspace-write');
  assert.deepEqual(f.trace, []);
  assert.deepEqual(permissionFrames(f.frames), [], 'no applied:true reaches anyone');
  f.poll();
  await run;
  assert.deepEqual(f.trace, [], 'the turn running then is not the canvas\'s to stop');
});

test('[R11-02] a caller known to have left before the poll looks: the claim itself refuses the mode (message first, then turn)', async () => {
  const f = probeFixture();
  const run = f.run();
  await settle();
  f.event('user/message', { id: 'm', source: { kind: 'user', rpcId: f.prompts[0].requestId } });
  f.close();
  f.event('turn/start', { turn: 1 });
  assert.deepEqual(f.trace, []);
  assert.deepEqual(permissionFrames(f.frames), []);
  f.poll();
  await run;
  assert.deepEqual(f.trace, []);
});

test('[R11-02] the same caller still waited for: both canvas turns run in their own mode, and each ends as the person set it', async () => {
  const f = probeFixture();
  const runs = [f.run('allow'), f.run('auto')];
  await settle();
  f.event('turn/start', { turn: 1 });
  f.event('user/message', { source: { kind: 'user', rpcId: f.prompts[0].requestId } });
  assert.equal(f.mode(), 'danger-full-access');
  f.event('turn/end', { turn: 1 });
  assert.equal(f.mode(), 'workspace-write');
  f.event('turn/start', { turn: 2 });
  f.event('user/message', { source: { kind: 'user', rpcId: f.prompts[1].requestId } });
  assert.equal(f.mode(), 'auto');
  f.event('turn/end', { turn: 2 });
  await Promise.all(runs);
  assert.deepEqual(f.trace, ['danger-full-access', 'workspace-write', 'auto', 'workspace-write']);
});
