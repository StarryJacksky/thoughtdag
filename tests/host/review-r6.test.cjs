// What the review of runs on disk found on the host side (its R6 numbers are
// kept in the test names): cleaning up after a run deleted the materials of
// runs still under way and materials something had rewritten, and cleaning up
// snapshots could delete one that a run had just frozen again or recorded. On
// real temp folders, with pauses under the file-system calls; nothing here
// touches a real project or a real agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fixture, entryIdOf } = require('./helpers/workspace-fixture.cjs');
const { materialize, pruneRuns } = require('../../runtime/execution/materialize.cjs');
const ops = require('../../runtime/agents/ops.cjs');

const setup = fixture(test, 'review-r6');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const HOUR = 60 * 60 * 1000;

// ── R6-01: materials ───────────────────────────────────────────────

const roots = [];
test.after(() => { for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true }); });
function runsRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-runs-'));
  roots.push(dir);
  return dir;
}
const recordOf = (runId, state) => ({
  schemaVersion: '1', runId, graphId: 'canvas-1', taskNodeId: 'n1', targetId: 'target_1', targetRevision: 'rev_1',
  inputDigest: 'sha256:' + 'a'.repeat(64), executionDigest: 'sha256:' + 'b'.repeat(64), graphRevision: 'sha256:' + 'c'.repeat(64),
  runtime: { kind: 'provider', runtime: null, connectionRef: 'p', model: 'p/m', effort: null, capabilityVersion: null },
  inputs: [], nativeBinding: null, output: null, state, preparedAt: '2026-10-16T00:00:00.000Z', endedAt: null,
});
const nodeInput = (inputId, name, bytes) => ({ inputId, source: { kind: 'attachment', nodeId: 'n', attachmentId: 'a' }, snapshotId: `node:${'0'.repeat(64)}`, contentHash: sha256(bytes), payload: 'text', displayName: name, size: { bytes: bytes.length }, reason: 'attached' });

/** One run's materials, as old as `minutesOld`, with a record in `state` (none when null). */
async function runOf(runs, name, state, minutesOld = 10) {
  const bytes = Buffer.from(`HELD ${name}`);
  await materialize({ runId: name, inputs: [nodeInput('in_1', 'a.txt', bytes)] }, path.join(runs, name), { provided: { in_1: bytes.toString('base64') } });
  if (state) fs.writeFileSync(path.join(runs, name, 'record.json'), JSON.stringify(recordOf(name, state)));
  const at = new Date(Date.now() - minutesOld * 60_000);
  fs.utimesSync(path.join(runs, name, 'materials'), at, at);
  return { dir: path.join(runs, name, 'materials'), file: path.join(runs, name, 'materials', 'in_1-a.txt'), bytes };
}
/** A newer run, which is the one kept. */
const newest = (runs) => runOf(runs, 'run_newest', 'completed', 0);

for (const state of ['completed', 'failed', 'cancelled']) {
  test(`[R6-01] the materials of a run that ended (${state}) and that are exactly what they were written as go; its record stays`, async () => {
    const runs = runsRoot();
    await newest(runs);
    await runOf(runs, 'run_old', state);
    assert.deepEqual(await pruneRuns(runs, { keep: 1 }), ['run_old']);
    assert.deepEqual(fs.readdirSync(path.join(runs, 'run_old')), ['record.json']);
  });
}

for (const state of ['prepared', 'starting', 'running', 'awaiting-approval', 'cancelling', 'unknown']) {
  test(`[R6-01] the materials of a run whose record says ${state} stay: it may still be reading them`, async () => {
    const runs = runsRoot();
    await newest(runs);
    const old = await runOf(runs, 'run_old', state);
    assert.deepEqual(await pruneRuns(runs, { keep: 1 }), []);
    assert.deepEqual(fs.readFileSync(old.file), old.bytes);
  });
}

test('[R6-01] the materials of a run with no record, or a record that cannot be read as one, stay: nothing says it ended', async () => {
  const runs = runsRoot();
  await newest(runs);
  const none = await runOf(runs, 'run_none', null);
  const broken = await runOf(runs, 'run_broken', null);
  fs.writeFileSync(path.join(runs, 'run_broken', 'record.json'), '{ not json');
  const other = await runOf(runs, 'run_other', null);
  fs.writeFileSync(path.join(runs, 'run_other', 'record.json'), JSON.stringify(recordOf('run_someone_else', 'completed')));
  assert.deepEqual(await pruneRuns(runs, { keep: 1 }), []);
  for (const { file, bytes } of [none, broken, other]) assert.deepEqual(fs.readFileSync(file), bytes);
});

test('[R6-01] a run that keeps no record beside its materials: they stay until the shell is told it is over, and then they go', async () => {
  const home = runsRoot();
  const bytes = Buffer.from('HELD');
  const agent = { kind: 'agent', runtime: 'codex', connectionRef: 'runtime:codex', model: 'codex/m', effort: null, capabilityVersion: null };
  const policy = { read: { scope: 'workspace', inputIds: ['in_1'] }, write: { scope: 'workspace' }, tools: { allow: [], mcpServers: [] }, network: 'on', recall: 'off', budget: { maxInputTokens: 1, reservedOutputTokens: 1, maxDurationMs: 1, maxOutputBytes: 1, maxCostUsd: null } };
  const answer = await ops.materializeRun(home, { runId: 'run_told', mode: 'workspace', runtime: agent, policy, inputs: [nodeInput('in_1', 'a.txt', bytes)] }, { in_1: bytes.toString('base64') });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const inRuns = path.join(home, '.thoughtdag', 'runs');
  await runOf(inRuns, 'run_newest', 'completed', 0);
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(inRuns, 'run_told', 'materials'), old, old);
  assert.deepEqual(await pruneRuns(inRuns, { keep: 1 }), [], 'not told yet: it stays');
  assert.equal((await ops.endRun(home, 'run_told', 'completed')).ok, true);
  assert.deepEqual(await pruneRuns(inRuns, { keep: 1 }), ['run_told']);
  assert.equal(fs.existsSync(path.join(inRuns, 'run_told')), false, 'nothing is left of a run that kept no record');
  // told of a run that has nothing here, or of something that is no run: nothing is written anywhere
  assert.equal((await ops.endRun(home, 'run_nobody', 'completed')).ok, false);
  assert.equal(fs.existsSync(path.join(inRuns, 'run_nobody')), false);
  assert.equal((await ops.endRun(home, '../run_x', 'completed')).ok, false);
  assert.equal((await ops.endRun('relative/dir', 'run_told', 'completed')).ok, false);
});

const edits = {
  'its content rewritten under the same name': ({ dir, file }) => { fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'EDITED_BY_THE_AGENT'); void dir; },
  'its file replaced by another under the same name': ({ dir, file }) => { fs.writeFileSync(path.join(dir, '.t'), 'REPLACED_ATOMICALLY'); fs.renameSync(path.join(dir, '.t'), file); },
  'a file added beside it': ({ dir }) => fs.writeFileSync(path.join(dir, 'notes.txt'), 'ADDED'),
  'its file taken away': ({ file }) => fs.unlinkSync(file),
  'its file replaced by a folder': ({ file }) => { fs.unlinkSync(file); fs.mkdirSync(file); },
  'its file replaced by a link': ({ dir, file }) => { fs.writeFileSync(path.join(dir, '..', 'elsewhere.txt'), 'HELD'); fs.unlinkSync(file); fs.symlinkSync(path.join(dir, '..', 'elsewhere.txt'), file); },
};
for (const [what, edit] of Object.entries(edits)) {
  test(`[R6-01] the materials of a run that ended stay when they have ${what}`, async () => {
    const runs = runsRoot();
    await newest(runs);
    const old = await runOf(runs, 'run_old', 'completed');
    edit(old);
    // the edit makes the folder look new; old all the same, it is the one that is due
    const aged = new Date(Date.now() - 3600_000);
    fs.utimesSync(old.dir, aged, aged);
    const before = fs.readdirSync(old.dir).sort();
    assert.deepEqual(await pruneRuns(runs, { keep: 1 }), []);
    assert.deepEqual(fs.readdirSync(old.dir).sort(), before);
  });
}

test('[R6-01] materials rewritten at the very moment they are being taken away stay', async () => {
  const runs = runsRoot();
  await newest(runs);
  const old = await runOf(runs, 'run_old', 'completed');
  // whichever step is the one that takes the folder out of use: the edit lands just before it
  const real = { rm: fsp.rm, rename: fsp.rename };
  let edited = false;
  const edit = (target) => {
    if (edited || !String(target).startsWith(old.dir)) return;
    edited = true;
    fs.writeFileSync(path.join(old.dir, '.t'), 'EDITED_AT_THE_LAST_MOMENT');
    fs.renameSync(path.join(old.dir, '.t'), old.file);
  };
  fsp.rm = async (target, ...rest) => { edit(target); return real.rm(target, ...rest); };
  fsp.rename = async (from, ...rest) => { edit(from); return real.rename(from, ...rest); };
  let removed;
  try { removed = await pruneRuns(runs, { keep: 1 }); } finally { Object.assign(fsp, real); }
  assert.ok(edited, 'the test reached the step');
  assert.deepEqual(removed, []);
  assert.equal(fs.readFileSync(old.file, 'utf8'), 'EDITED_AT_THE_LAST_MOMENT');
  assert.deepEqual(fs.readdirSync(path.join(runs, 'run_old')).sort(), ['materials', 'record.json'], 'the folder is back at its name, nothing beside it');
});

test('[R6-01] the materials of a run are not lost through a link put where they are', async () => {
  const runs = runsRoot();
  await newest(runs);
  await runOf(runs, 'run_old', 'completed');
  const elsewhere = runsRoot();
  fs.writeFileSync(path.join(elsewhere, 'mine.txt'), 'NOT_A_RUNS');
  fs.rmSync(path.join(runs, 'run_old', 'materials'), { recursive: true, force: true });
  fs.symlinkSync(elsewhere, path.join(runs, 'run_old', 'materials'));
  assert.deepEqual(await pruneRuns(runs, { keep: 1 }), []);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'mine.txt'), 'utf8'), 'NOT_A_RUNS');
});

test('[R6-01] the report\'s case: the 21st run started leaves a running run\'s edited materials alone, through the door every run goes by', async () => {
  const home = runsRoot();
  const inRuns = path.join(home, '.thoughtdag', 'runs');
  fs.mkdirSync(inRuns, { recursive: true });
  const old = await runOf(inRuns, 'run_0', 'running', 600);
  fs.writeFileSync(path.join(old.dir, '.t'), 'EDITED_BY_THE_AGENT');
  fs.renameSync(path.join(old.dir, '.t'), old.file);
  const aged = new Date(Date.now() - 600 * 60_000);
  fs.utimesSync(old.dir, aged, aged);
  for (let i = 1; i <= 20; i++) await runOf(inRuns, `run_${i}`, 'completed', 500 - i);
  const bytes = Buffer.from('NEW');
  const agent = { kind: 'agent', runtime: 'codex', connectionRef: 'runtime:codex', model: 'codex/m', effort: null, capabilityVersion: null };
  const policy = { read: { scope: 'workspace', inputIds: ['in_1'] }, write: { scope: 'workspace' }, tools: { allow: [], mcpServers: [] }, network: 'on', recall: 'off', budget: { maxInputTokens: 1, reservedOutputTokens: 1, maxDurationMs: 1, maxOutputBytes: 1, maxCostUsd: null } };
  const answer = await ops.materializeRun(home, { runId: 'run_new', mode: 'workspace', runtime: agent, policy, inputs: [nodeInput('in_1', 'a.txt', bytes)] }, { in_1: bytes.toString('base64') });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(fs.readFileSync(old.file, 'utf8'), 'EDITED_BY_THE_AGENT');
});

// ── R6-06: snapshots ───────────────────────────────────────────────

const snapshotFile = (project, snapshotId) => path.join(project, '.thoughtdag', 'snapshots', snapshotId.slice('snap_'.length));
const age = (file, ms) => { const at = new Date(Date.now() - ms); fs.utimesSync(file, at, at); };
const runRecord = (runId, frozen, fileId) => ({ ...recordOf(runId, 'prepared'), inputs: [{ inputId: 'in_0', fileId, snapshotId: frozen.snapshotId, contentHash: frozen.contentHash }] });

/** A workspace with a file frozen long ago and held by nothing, and a hook at each step of cleaning up. */
async function oldSnapshot({ recordedAndForgotten = false } = {}) {
  const hooks = {};
  const fire = async (step, target) => { if (hooks[step] && String(target).includes(`${path.sep}snapshots`)) { const run = hooks[step]; delete hooks[step]; await run(); } };
  const io = {
    ...fs.promises,
    readdir: async (target, ...rest) => { const answer = await fs.promises.readdir(target, ...rest); await fire('listed', target); return answer; },
    stat: async (target, ...rest) => { await fire('before-stat', target); const answer = await fs.promises.stat(target, ...rest); await fire('after-stat', target); return answer; },
    rm: async (target, ...rest) => { await fire('before-rm', target); return fs.promises.rm(target, ...rest); },
  };
  const made = await setup({ io });
  fs.writeFileSync(made.at('notes/old.md'), 'OLD_CONTENT\n');
  const record = await made.service.registerEntry(made.workspace.workspaceId, entryIdOf('notes/old.md'));
  const frozen = await made.service.freezeFile(record.fileId);
  // a run recorded it and that record is gone: nothing is left holding it, and nothing but its age protects it
  if (recordedAndForgotten) {
    await made.service.recordRun(made.workspace.workspaceId, runRecord('run_gone', frozen, record.fileId));
    fs.rmSync(path.join(made.project, '.thoughtdag', 'runs', 'run_gone'), { recursive: true });
  }
  age(snapshotFile(made.project, frozen.snapshotId), 30 * 24 * HOUR);
  return { ...made, hooks, record, frozen, file: snapshotFile(made.project, frozen.snapshotId) };
}
/** Started at a chosen moment; what is held apart from the clean-up waits for it, and the clean-up goes on. */
const alongside = async (start) => { const run = start(); run.catch(() => {}); await Promise.race([run.then(() => {}, () => {}), pause(80)]); return { run }; };

for (const step of ['listed', 'before-stat', 'after-stat', 'before-rm']) {
  test(`[R6-06] a snapshot frozen again and recorded while it is being cleaned up (${step}) stays, for the new run and the old`, async () => {
    const { service, workspace, hooks, record, file } = await oldSnapshot({ recordedAndForgotten: true });
    let during = null;
    hooks[step] = async () => {
      during = await alongside(async () => {
        const again = await service.freezeFile(record.fileId);
        await service.recordRun(workspace.workspaceId, runRecord('run_new', again, record.fileId));
      });
    };
    await service.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR });
    await during.run;
    assert.ok(fs.existsSync(file), 'the snapshot the new run names is there');
    assert.deepEqual((await service.reconcileRuns(workspace.workspaceId)).runs.map((r) => [r.runId, r.missing]), [['run_new', []]]);
    assert.deepEqual([...fs.readFileSync(file)], [...Buffer.from('OLD_CONTENT\n')]);
  });
}

test('[R6-06] a snapshot frozen long before and recorded only now, during the clean-up, is not taken from the run that froze it', async () => {
  const { service, workspace, hooks, record, frozen, file } = await oldSnapshot();
  let during = null;
  hooks.listed = async () => {
    during = await alongside(() => service.recordRun(workspace.workspaceId, runRecord('run_slow', frozen, record.fileId)));
  };
  await service.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR });
  await during.run;
  assert.ok(fs.existsSync(file));
  assert.deepEqual((await service.reconcileRuns(workspace.workspaceId)).runs.map((r) => [r.runId, r.missing]), [['run_slow', []]]);
});

test('[R6-06] once a run has recorded what it froze, nothing but its record holds it: a snapshot no record names goes when it is old enough', async () => {
  const { service, workspace, record, frozen, file, start } = await oldSnapshot();
  await service.recordRun(workspace.workspaceId, runRecord('run_1', frozen, record.fileId));
  assert.deepEqual(await service.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR }), { removed: [], refused: null });
  // after a restart nothing is remembered of what was frozen and not recorded: the grace period is what protects it
  fs.rmSync(path.join(path.dirname(path.dirname(file)), 'runs', 'run_1'), { recursive: true });
  const restarted = start({ io: fs.promises });
  assert.deepEqual(await restarted.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR }), { removed: [frozen.snapshotId], refused: null });
});

test('[R6-06] a record that cannot be read still stops the clean-up', async () => {
  const { workspace, project, file, start } = await oldSnapshot();
  fs.mkdirSync(path.join(project, '.thoughtdag', 'runs', 'run_broken'), { recursive: true });
  fs.writeFileSync(path.join(project, '.thoughtdag', 'runs', 'run_broken', 'record.json'), '{ not json');
  const restarted = start({ io: fs.promises });
  assert.deepEqual(await restarted.collectSnapshots(workspace.workspaceId, { graceMs: 24 * HOUR }), { removed: [], refused: 'unreadable-record' });
  assert.ok(fs.existsSync(file));
});
