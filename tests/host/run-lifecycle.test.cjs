// What a run does between being asked for and ending (T17), against the stand-ins:
// what the host keeps for a page that was not listening, what becomes of questions
// when a run is stopped or answered twice, and whose a stop is. Nothing here talks
// to a real CLI or a real session.
const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeRuntimes } = require('../helpers/fake-runtimes.cjs');

const fake = installFakeRuntimes();
const { createCodexRuntime } = require('../../runtime/agents/codex.cjs');
const { createPiRuntime } = require('../../runtime/agents/pi.cjs');
const { createRunJournal } = require('../../runtime/execution/run-journal.cjs');

test.after(() => fake.cleanup());
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 8000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > ms) throw new Error('it did not come to that'); await pause(10); } };

test('[T17] every event is numbered in the order it came, and asked for again after any number', () => {
  const j = createRunJournal();
  assert.equal(j.note('a', { type: 'session' }).seq, 1);
  assert.equal(j.note('a', { type: 'message_update' }).seq, 2);
  assert.equal(j.note('b', { type: 'session' }).seq, 1, 'each run counts its own');
  assert.deepEqual(j.since('a', 1).events.map((e) => e.type), ['message_update']);
  assert.deepEqual(j.since('a').events.map((e) => e.seq), [1, 2]);
  assert.equal(j.since('a', 1).complete, true);
  assert.equal(j.since('a').state, 'running');
});

test('[T17] how a run stands: under way, over, or not known to this host', () => {
  const j = createRunJournal();
  j.note('a', { type: 'session' });
  assert.equal(j.since('a').state, 'running');
  j.note('a', { type: 'run_end', how: 'end' });
  assert.equal(j.since('a').state, 'ended');
  assert.deepEqual(j.since('never'), { state: 'unknown', events: [], complete: false });
});

test('[T17] when a run\'s oldest events are let go, the answer says it is not all of them', () => {
  const j = createRunJournal({ maxEvents: 3 });
  for (let i = 0; i < 5; i++) j.note('a', { type: 'message_update', i });
  const kept = j.since('a');
  assert.deepEqual(kept.events.map((e) => e.seq), [3, 4, 5]);
  assert.equal(kept.complete, false);
  assert.equal(j.since('a', 2).complete, true, 'everything after 2 is still there');
});

test('[T17] runs long over are let go; one under way is not', () => {
  const j = createRunJournal({ keepEnded: 1 });
  j.note('open', { type: 'session' });
  j.note('a', { type: 'run_end' });
  j.note('b', { type: 'run_end' });
  assert.equal(j.since('a').state, 'unknown');
  assert.equal(j.since('b').state, 'ended');
  assert.equal(j.since('open').state, 'running');
});

// ── questions ──

/** A stand-in Codex that asks, for each turn, what TD_FAKE_SCRIPT says. */
const asking = (t, approvals) => {
  fake.clear();
  fake.script({ hold: true, approvals });
  const codex = createCodexRuntime();
  t.after(() => codex.shutdown());
  return codex;
};
async function under(codex, prompt = 'hello') {
  const events = [];
  let ended; const end = new Promise((resolve) => { ended = resolve; });
  const runId = await codex.run({ runtime: 'codex', cwd: fake.project, prompt, model: { provider: 'codex', id: 'gpt-synthetic' } }, ({ event }) => { events.push(event); if (event.type === 'run_end') ended(); });
  return { runId, events, end };
}
const replies = () => fake.read('codex').filter((r) => r.kind === 'in' && r.msg.result !== undefined).map((r) => r.msg);
const questions = (run) => run.events.filter((e) => e.type === 'question');

test('[T17] two questions of one run are told apart: each has its own answer, and answering one leaves the other open', async (t) => {
  const codex = asking(t, ['first command', 'second command']);
  const run = await under(codex);
  await until(() => questions(run).length === 2);
  const [a, b] = questions(run);
  assert.notEqual(a.id, b.id);
  assert.equal(codex.answer(run.runId, b.id, { confirmed: true }), true);
  await until(() => replies().length === 1);
  assert.equal(replies()[0].result.decision, 'accept');
  assert.equal(run.events.filter((e) => e.type === 'question_answered').map((e) => e.id).join(), b.id);
  codex.abort(run.runId);
  await run.end;
});

test('[T17] a question answered twice is answered once: the second changes nothing, and says so', async (t) => {
  const codex = asking(t, ['a command']);
  const run = await under(codex);
  await until(() => questions(run).length === 1);
  const { id } = questions(run)[0];
  assert.equal(codex.answer(run.runId, id, { confirmed: true }), true);
  assert.equal(codex.answer(run.runId, id, { confirmed: false }), false);
  await until(() => replies().length === 1);
  await pause(30);
  assert.equal(replies().length, 1);
  assert.equal(replies()[0].result.decision, 'accept');
  assert.equal(run.events.filter((e) => e.type === 'question_answered').length, 1);
  codex.abort(run.runId);
  await run.end;
});

test('[T17] stopping a run withdraws its open questions as a no, and says they were withdrawn', async (t) => {
  const codex = asking(t, ['first command', 'second command']);
  const run = await under(codex);
  await until(() => questions(run).length === 2);
  codex.abort(run.runId);
  await run.end;
  assert.deepEqual(replies().map((r) => r.result.decision), ['decline', 'decline']);
  assert.deepEqual(run.events.filter((e) => e.type === 'question_answered').map((e) => e.outcome), ['cancelled', 'cancelled']);
  assert.equal(codex.answer(run.runId, questions(run)[0].id, { confirmed: true }), false, 'a late answer reaches nothing');
});

test('[T17] a question is answered only by the run it belongs to, and another run\'s stop leaves it open', async (t) => {
  const codex = asking(t, ['a command']);
  const a = await under(codex, 'A');
  await until(() => questions(a).length === 1);
  const b = await under(codex, 'B');
  await until(() => questions(b).length === 1);
  const own = questions(a)[0].id;
  assert.equal(codex.answer(b.runId, own, { confirmed: true }), false);
  codex.abort(b.runId);
  await b.end;
  assert.equal(replies().filter((r) => r.result.decision === 'accept').length, 0);
  assert.equal(codex.answer(a.runId, own, { confirmed: true }), true, 'still open');
  codex.abort(a.runId);
  await a.end;
});

// ── a run still waiting its turn (L02) ──

const startPi = (t, script = {}) => {
  fake.clear();
  fake.script(script);
  const pi = createPiRuntime();
  t.after(() => pi.shutdown());
  return pi;
};
const piAsked = () => fake.read('pi').filter((r) => r.kind === 'in').map((r) => r.msg);
async function piRun(pi, prompt) {
  const events = [];
  let ended; const end = new Promise((resolve) => { ended = resolve; });
  const runId = await pi.run({ runtime: 'pi', cwd: fake.project, prompt }, ({ event }) => { events.push(event); if (event.type === 'run_end') ended(); });
  return { runId, events, end };
}

test('[T17][L02] stopping a run still waiting its turn stops that run, and not the one at work', async (t) => {
  const pi = startPi(t);
  const a = await piRun(pi, 'PROMPT_A');
  await until(() => piAsked().some((m) => m.type === 'prompt'));
  const b = await piRun(pi, 'PROMPT_B');
  assert.equal(pi.abort(b.runId), true);
  await pause(40);
  assert.equal(piAsked().some((m) => m.type === 'abort'), false, 'the process at work on A is told nothing');
  assert.equal(a.events.some((e) => e.type === 'run_end'), false, 'A is still under way');
  pi.abort(a.runId);
  await a.end;
  await b.end;
  assert.equal(b.events.at(-1).how, 'aborted');
  assert.equal(piAsked().filter((m) => m.type === 'prompt').map((m) => m.message).join(), 'PROMPT_A', 'B never reached the process');
});

test('[T17][L02] stopping the run at work stops it, and the one waiting then runs', async (t) => {
  const pi = startPi(t);
  const a = await piRun(pi, 'PROMPT_A');
  await until(() => piAsked().some((m) => m.type === 'prompt'));
  const b = await piRun(pi, 'PROMPT_B');
  pi.abort(a.runId);
  await a.end;
  await until(() => piAsked().filter((m) => m.type === 'prompt').length === 2);
  pi.abort(b.runId);
  await b.end;
});
