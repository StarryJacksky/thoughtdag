// What the review of the upstream 0.5.26 merge found on the host side (its
// R9 numbers are kept in the test names): a canvas backup written straight
// over the last good one, so a write that dies half way leaves neither, and
// the canvas's permission mode switched on a session shared with the person
// before the canvas's own turn had started there, and put back per request
// rather than per turn. Backups are written to a real temp folder with
// faults injected under node:fs/promises; the plugin runs on a stand-in
// harness with synthetic sessions. Nothing here touches a real project or a
// real agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const soon = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const errno = (code) => Object.assign(new Error(`${code}: injected`), { code });

// ── faults under node:fs/promises ──────────────────────────────────────
// Installed before the backup module is loaded: it takes its functions
// from node:fs/promises when it is required. A fault fires once, for a
// write under `faults.under`, at one stage of writing a file: opening it,
// writing its bytes (12 of them reach the file, then the disk is full),
// flushing it to the disk, closing it, or putting it in place.

const real = { writeFile: fsp.writeFile, open: fsp.open, rename: fsp.rename };
const faults = { under: null, stage: null };
/** A write held at the gate: the first write whose bytes `matches` waits until it is let through. */
let gate = null;
const inScope = (file) => typeof file === 'string' && faults.under !== null && file.startsWith(faults.under);
const fire = (stage) => { if (faults.stage !== stage) return false; faults.stage = null; return true; };
async function atGate(data) {
  if (gate && !gate.taken && gate.matches(String(data))) { gate.taken = true; gate.arrived(); await gate.passage; }
}
function holdWrite(matches) {
  let arrived = () => {};
  let release = () => {};
  const reached = new Promise((resolve) => { arrived = resolve; });
  const passage = new Promise((resolve) => { release = resolve; });
  gate = { matches, taken: false, arrived, passage };
  return { reached, release: () => { release(); gate = null; } };
}

fsp.writeFile = async function writeFile(file, data, ...rest) {
  if (inScope(file)) {
    if (fire('open')) throw errno('EMFILE');
    await atGate(data);
    if (fire('write')) { await real.writeFile(file, String(data).slice(0, 12), ...rest); throw errno('ENOSPC'); }
  }
  return real.writeFile.call(this, file, data, ...rest);
};
fsp.open = async function open(file, flags, ...rest) {
  const writing = inScope(file) && /[wax+]/.test(String(flags ?? 'r'));
  if (writing && fire('open')) throw errno('EMFILE');
  const handle = await real.open.call(this, file, flags, ...rest);
  if (!writing) return handle;
  const writes = (method) => async (data, ...more) => {
    await atGate(data);
    if (fire('write')) { await handle[method](typeof data === 'string' ? data.slice(0, 12) : data.subarray(0, 12), ...more); throw errno('ENOSPC'); }
    return handle[method](data, ...more);
  };
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'writeFile' || key === 'write') return writes(key);
      if (key === 'sync' || key === 'datasync') return async () => { if (fire('sync')) throw errno('EIO'); return target[key](); };
      if (key === 'close') return async () => { await target.close(); if (fire('close')) throw errno('EIO'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};
fsp.rename = async function rename(from, to) {
  if (inScope(to) && fire('rename')) throw errno('EPERM');
  return real.rename.call(this, from, to);
};

const { writeBackup } = require('../../runtime/backup-write.cjs');

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-r9-backup-'));
test.after(() => fs.rmSync(backupRoot, { recursive: true, force: true }));
let folders = 0;
/** A picked backup folder, with a complete backup of the canvas already in it when `previous` is given. */
function folder(previous) {
  const dir = path.join(backupRoot, `f${++folders}`);
  fs.mkdirSync(dir, { recursive: true });
  if (previous !== undefined) fs.writeFileSync(path.join(dir, NAME), previous);
  faults.under = dir;
  return dir;
}
const NAME = 'Canvas.thoughtdag.json';
const canvasJson = (marker) => JSON.stringify({ version: 2, name: 'Canvas', nodes: [{ id: 'n1', data: { question: marker } }], edges: [] });
const PREVIOUS = canvasJson('THE_LAST_GOOD_BACKUP');
/** Everything in a folder, cli/ drawer included: a write leaves the backup and nothing beside it. */
const filesIn = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

// ── R9-01: a backup that fails part way keeps the one before it ────────

for (const stage of ['open', 'write', 'sync', 'close', 'rename']) {
  test(`[R9-01] a backup that fails at ${stage} leaves the previous backup whole and nothing beside it`, async () => {
    const dir = folder(PREVIOUS);
    faults.stage = stage;
    await assert.rejects(writeBackup({ dir, name: NAME, json: canvasJson('THE_NEW_ONE') }), 'the failure is reported');
    faults.stage = null;
    const left = fs.readFileSync(path.join(dir, NAME), 'utf8');
    assert.equal(left, PREVIOUS, 'the previous backup is byte for byte as it was');
    assert.equal(JSON.parse(left).nodes[0].data.question, 'THE_LAST_GOOD_BACKUP', 'and it still reads back as a canvas');
    assert.deepEqual(filesIn(dir), [NAME], 'no half-written file is left beside it');
  });
}

test('[R9-01] a first backup that fails leaves no file at all, and the next one writes it whole', async () => {
  const dir = folder();
  faults.stage = 'write';
  await assert.rejects(writeBackup({ dir, name: NAME, json: canvasJson('FIRST_TRY') }));
  assert.deepEqual(filesIn(dir), [], 'no partial backup stands where none was');
  const file = await writeBackup({ dir, name: NAME, json: canvasJson('SECOND_TRY') });
  assert.equal(file, path.join(dir, NAME));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nodes[0].data.question, 'SECOND_TRY', 'the retry wrote the backup whole');
  assert.deepEqual(filesIn(dir), [NAME]);
});

test('[R9-01] a retry after a failed backup replaces the previous backup only once it is written', async () => {
  const dir = folder(PREVIOUS);
  faults.stage = 'write';
  await assert.rejects(writeBackup({ dir, name: NAME, json: canvasJson('FAILED') }));
  assert.equal(fs.readFileSync(path.join(dir, NAME), 'utf8'), PREVIOUS);
  await writeBackup({ dir, name: NAME, json: canvasJson('RETRIED') });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, NAME), 'utf8')).nodes[0].data.question, 'RETRIED');
  assert.deepEqual(filesIn(dir), [NAME]);
});

test('[R9-01] two backups of one canvas end with the later one, whichever write finishes first', async () => {
  const dir = folder(PREVIOUS);
  // the automatic backup is slow to write; "back up now" is asked for while it is still writing
  const slow = holdWrite((data) => data.includes('AUTOMATIC'));
  const automatic = writeBackup({ dir, name: NAME, json: canvasJson('AUTOMATIC') });
  await slow.reached;
  const now = writeBackup({ dir, name: NAME, json: canvasJson('BACK_UP_NOW') });
  await soon(50);
  slow.release();
  await Promise.all([automatic, now]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, NAME), 'utf8')).nodes[0].data.question, 'BACK_UP_NOW', 'the backup asked for last is the one on disk');
  assert.deepEqual(filesIn(dir), [NAME]);
});

test('[R9-01] a mirror canvas in the cli/ drawer is kept the same way', async () => {
  const dir = folder();
  const rel = 'cli/Mirror-1a2b3c4d.thoughtdag.json';
  fs.mkdirSync(path.join(dir, 'cli'));
  fs.writeFileSync(path.join(dir, rel), PREVIOUS);
  faults.stage = 'write';
  await assert.rejects(writeBackup({ dir, name: rel, json: canvasJson('THE_NEW_ONE') }));
  assert.equal(fs.readFileSync(path.join(dir, rel), 'utf8'), PREVIOUS);
  assert.deepEqual(filesIn(dir), ['cli', path.join('cli', 'Mirror-1a2b3c4d.thoughtdag.json')]);
});

// ── R9-03: the canvas's permission mode, on a session shared with the person ──
// The plugin as shipped (dsh/lib/index.js), copied with the runtime it
// requires beside it, mounted on a stand-in harness. The harness's turns
// are driven by hand: a turn starts, the canvas's message enters it (named
// by the prompt's requestId), the turn ends.

// a turn the plugin waits for is bounded by a 20-minute timer it does not clear: let it not keep the test process alive
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function (fn, ms, ...args) {
  const timer = realSetTimeout(fn, ms, ...args);
  if (typeof ms === 'number' && ms >= 60_000) timer.unref?.();
  return timer;
};

const PRESETS = ['read-only', 'workspace-write', 'auto', 'danger-full-access'];
let harness = null;

async function standIn() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-r9-plugin-'));
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
        prompts.push({ ...req, presetThen: preset.get(req.sessionId) });
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
  const server = http.createServer((req, res) => api(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let seq = 0;
  const event = (id, type, data) => emitEvent('session/event', sessions.get(id), { type, data, seq: ++seq });
  return {
    dir, server, preset, applied, prompts, cancels, refuse,
    /** A session the person has open in the harness, at the preset they set. */
    session(id, setting = 'workspace-write') { sessions.set(id, { id }); preset.set(id, setting); },
    /** Ask on the canvas, continuing session `id` in permission `mode`; resolves with the frames of the stream. */
    ask(id, mode) {
      const leave = new AbortController();
      const done = fetch(`http://127.0.0.1:${port}/thoughtdag/api/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'harness/agent', messages: [{ role: 'user', content: `a question in ${mode}` }], harness: { session: id, permission: mode } }),
        signal: leave.signal,
      }).then((r) => r.text()).then((text) => text.split('\n').filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]').map((l) => JSON.parse(l.slice(6))), () => 'left');
      return { done, leave: () => leave.abort() };
    },
    async promptCount(n) { for (let i = 0; i < 200 && prompts.length < n; i++) await soon(5); assert.equal(prompts.length, n, `${n} prompts reached the session`); },
    turnStarts(id, turn) { event(id, 'turn/start', { turn }); },
    /** The canvas message of prompt `index` enters the turn running now. */
    entersTurn(id, index) { event(id, 'user/message', { id: `msg-${index}`, source: { kind: 'user', rpcId: prompts[index].requestId } }); },
    turnEnds(id, turn) { event(id, 'turn/end', { turn }); },
  };
}

test.before(async () => { harness = await standIn(); });
// a turn a failed test left waiting holds its request open: closing the connections lets the plugin see its caller leave
test.after(() => { harness?.server.closeAllConnections(); harness?.server.close(); if (harness) fs.rmSync(harness.dir, { recursive: true, force: true }); });

const permissionFrames = (frames) => (Array.isArray(frames) ? frames.filter((f) => f.permission).map((f) => f.permission) : frames);

test('[R9-03] a canvas turn queued behind the person\'s running turn leaves the session as the person set it until its own turn starts', async () => {
  const h = harness;
  h.session('S1');
  h.turnStarts('S1', 1); // the person's own turn is running
  const before = h.applied.length;
  const a = h.ask('S1', 'allow');
  await h.promptCount(1);
  assert.equal(h.prompts[0].mode, 'queue');
  assert.equal(h.prompts[0].presetThen, 'workspace-write', 'the message was queued with the session as the person set it');
  assert.equal(h.preset.get('S1'), 'workspace-write', 'the person\'s turn still runs as they set it');
  h.turnEnds('S1', 1);
  h.turnStarts('S1', 2);
  h.entersTurn('S1', 0);
  assert.equal(h.preset.get('S1'), 'danger-full-access', 'the canvas\'s turn runs in its mode');
  h.turnEnds('S1', 2);
  assert.equal(h.preset.get('S1'), 'workspace-write', 'and the session is put back as its turn ends');
  assert.deepEqual(permissionFrames(await a.done), [{ mode: 'allow', applied: true }]);
  assert.deepEqual(h.applied.slice(before), ['S1:danger-full-access', 'S1:workspace-write']);
});

test('[R9-03] a canvas message the session refuses to queue changes nothing', async () => {
  const h = harness;
  h.session('S2');
  h.refuse.add('S2');
  const before = h.applied.length;
  const promptsBefore = h.prompts.length;
  const a = h.ask('S2', 'allow');
  const frames = await a.done;
  assert.ok(Array.isArray(frames) && frames.some((f) => f.error), 'the refusal reaches the canvas');
  assert.equal(h.prompts[promptsBefore].presetThen, 'workspace-write', 'nothing was switched before the message was queued');
  assert.deepEqual(h.applied.slice(before), [], 'and nothing was switched or put back at all');
  assert.equal(h.preset.get('S2'), 'workspace-write');
});

for (const [first, second, firstWant, secondWant] of [
  ['allow', 'auto', 'danger-full-access', 'auto'],
  ['auto', 'allow', 'auto', 'danger-full-access'],
  ['allow', 'allow', 'danger-full-access', 'danger-full-access'],
]) {
  test(`[R9-03] two canvas turns queued in one session (${first}, then ${second}) each run in their own mode, and the session ends as the person set it`, async () => {
    const h = harness;
    const id = `S-${first}-${second}`;
    h.session(id);
    h.turnStarts(id, 1); // the person's turn
    const at = h.prompts.length;
    const a = h.ask(id, first);
    await h.promptCount(at + 1);
    const b = h.ask(id, second);
    await h.promptCount(at + 2);
    assert.equal(h.preset.get(id), 'workspace-write', 'neither queued turn changed the person\'s running turn');
    h.turnEnds(id, 1);
    h.turnStarts(id, 2);
    h.entersTurn(id, at);
    assert.equal(h.preset.get(id), firstWant, `the first canvas turn runs in ${first}`);
    h.turnEnds(id, 2);
    assert.equal(h.preset.get(id), 'workspace-write', 'between the two turns the session is the person\'s again');
    h.turnStarts(id, 3);
    h.entersTurn(id, at + 1);
    assert.equal(h.preset.get(id), secondWant, `the second canvas turn runs in ${second}`);
    h.turnEnds(id, 3);
    await Promise.all([a.done, b.done]);
    assert.equal(h.preset.get(id), 'workspace-write', 'nothing of the canvas\'s modes is left on the session');
  });
}

test('[R9-03] the later request ending first: the canvas leaves its queued turn while the earlier one runs, and the session still ends as the person set it', async () => {
  const h = harness;
  h.session('S3');
  const at = h.prompts.length;
  const a = h.ask('S3', 'allow');
  await h.promptCount(at + 1);
  const b = h.ask('S3', 'auto');
  await h.promptCount(at + 2);
  h.turnStarts('S3', 1);
  h.entersTurn('S3', at);
  assert.equal(h.preset.get('S3'), 'danger-full-access');
  b.leave(); // the second request ends before the first
  assert.equal(await b.done, 'left');
  await soon(700); // the plugin looks for a caller that left every 500 ms
  assert.equal(h.preset.get('S3'), 'danger-full-access', 'the first turn keeps running in its mode');
  assert.deepEqual(h.cancels.filter((id) => id === 'S3'), [], 'and is not stopped by the second request leaving');
  h.turnEnds('S3', 1);
  await a.done;
  assert.equal(h.preset.get('S3'), 'workspace-write');
  // the harness runs the abandoned message anyway: it is the person's session again, and runs as they set it
  h.turnStarts('S3', 2);
  h.entersTurn('S3', at + 1);
  assert.equal(h.preset.get('S3'), 'workspace-write');
  h.turnEnds('S3', 2);
  assert.equal(h.preset.get('S3'), 'workspace-write');
});

test('[R9-03] a canvas turn left while it waits in the queue never touches the session', async () => {
  const h = harness;
  h.session('S4');
  h.turnStarts('S4', 1); // the person's turn
  const before = h.applied.length;
  const at = h.prompts.length;
  const a = h.ask('S4', 'allow');
  await h.promptCount(at + 1);
  a.leave();
  await a.done;
  await soon(700);
  assert.deepEqual(h.cancels.filter((id) => id === 'S4'), [], 'the person\'s running turn is not stopped for it');
  h.turnEnds('S4', 1);
  assert.deepEqual(h.applied.slice(before), [], 'the person\'s turn ran as they set it from start to end');
  assert.equal(h.preset.get('S4'), 'workspace-write');
  // the harness runs the message the canvas left: no canvas is waiting for it, and it runs as the person set the session
  h.turnStarts('S4', 2);
  h.entersTurn('S4', at);
  assert.equal(h.preset.get('S4'), 'workspace-write');
  h.turnEnds('S4', 2);
  assert.deepEqual(h.applied.slice(before), []);
});

test('[R9-03] a canvas turn the canvas leaves while it runs is stopped, and the session is put back as it stops', async () => {
  const h = harness;
  h.session('S7');
  const at = h.prompts.length;
  const a = h.ask('S7', 'allow');
  await h.promptCount(at + 1);
  h.turnStarts('S7', 1);
  h.entersTurn('S7', at);
  assert.equal(h.preset.get('S7'), 'danger-full-access');
  a.leave();
  await a.done;
  await soon(700);
  assert.deepEqual(h.cancels.filter((id) => id === 'S7'), ['S7'], 'the canvas\'s own turn is stopped');
  assert.equal(h.preset.get('S7'), 'workspace-write', 'and the session is the person\'s again');
});

test('[R9-03] a setting the person changes while the canvas\'s turn runs is theirs and stays', async () => {
  const h = harness;
  h.session('S5');
  const at = h.prompts.length;
  const a = h.ask('S5', 'allow');
  await h.promptCount(at + 1);
  h.turnStarts('S5', 1);
  h.entersTurn('S5', at);
  assert.equal(h.preset.get('S5'), 'danger-full-access');
  h.preset.set('S5', 'read-only'); // in the harness's own settings
  h.turnEnds('S5', 1);
  await a.done;
  assert.equal(h.preset.get('S5'), 'read-only');
});

test('[R9-03] a session with a hand-tuned setting is left as it is, and the canvas is told so when its turn starts', async () => {
  const h = harness;
  h.session('S6', 'custom');
  const at = h.prompts.length;
  const a = h.ask('S6', 'auto');
  await h.promptCount(at + 1);
  h.turnStarts('S6', 1);
  h.entersTurn('S6', at);
  h.turnEnds('S6', 1);
  assert.deepEqual(permissionFrames(await a.done), [{ mode: 'auto', applied: false, reason: 'custom' }]);
  assert.equal(h.preset.get('S6'), 'custom');
});
