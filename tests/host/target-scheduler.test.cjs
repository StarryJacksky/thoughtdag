// Who runs when, and whose a stop or an answer is (T28), on a stand-in for the
// runtimes: it starts nothing real, and the test says when each run speaks and ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTargetScheduler } = require('../../runtime/execution/target-scheduler.cjs');

const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A runtime that holds each run until told, and notes what it was asked. */
function standIn() {
  const started = [];
  const stopped = [];
  const answers = [];
  let next = 1;
  const runtime = {
    async run(req, onEvent) {
      const runId = `native-${next++}`;
      started.push({ req, runId, say: (event) => onEvent({ runId, event }) });
      return runId;
    },
    abort(runId) { stopped.push(runId); started.find((s) => s.runId === runId)?.say({ type: 'run_end', how: 'aborted', text: '' }); return true; },
    answer(runId, requestId, response) { answers.push({ runId, requestId, response }); return true; },
  };
  const of = (prompt) => started.find((s) => s.req.prompt === prompt);
  return { runtime, started, stopped, answers, of, promptsStarted: () => started.map((s) => s.req.prompt) };
}

function setup(options = {}) {
  const stand = standIn();
  const told = [];
  const scheduler = createTargetScheduler({ runtimeFor: () => stand.runtime, onEvent: (payload) => told.push(payload), ...options });
  const heard = (id) => told.filter((p) => p.runId === id).map((p) => p.event);
  const ended = (prompt) => stand.of(prompt).say({ type: 'run_end', how: 'end', text: 'done' });
  return { ...stand, scheduler, told, heard, ended };
}
const ask = (s, prompt, more = {}) => s.scheduler.enqueue({ runtime: 'codex', cwd: `/synthetic/${prompt}`, prompt, ...more });

test('[T28] two runs at most at once by default; the third waits, and starts when one ends', async () => {
  const s = setup();
  await ask(s, 'a'); await ask(s, 'b'); await ask(s, 'c');
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a', 'b']);
  s.ended('a');
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a', 'b', 'c']);
});

test('[T28] how many at once can be set', async () => {
  const s = setup({ maxActiveRuns: 1 });
  await ask(s, 'a'); await ask(s, 'b');
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a']);
});

test('[T28] one target has one run at a time, and its runs keep their order', async () => {
  const s = setup({ maxActiveRuns: 5 });
  await ask(s, 'x1', { target: { targetId: 'tx' } });
  await ask(s, 'x2', { target: { targetId: 'tx' } });
  await ask(s, 'y1', { target: { targetId: 'ty' } });
  await pause();
  assert.deepEqual(s.promptsStarted(), ['x1', 'y1']);
  s.ended('x1');
  await pause();
  assert.deepEqual(s.promptsStarted(), ['x1', 'y1', 'x2']);
});

test('[T28] one native session is written to by one run at a time, whichever targets ask', async () => {
  const s = setup({ maxActiveRuns: 5 });
  const sessionPath = '/synthetic/sessions/rollout-11111111-2222-4333-8444-555555555555.jsonl';
  await ask(s, 'a', { sessionPath, target: { targetId: 'ta' } });
  await ask(s, 'b', { sessionPath, target: { targetId: 'tb' } });
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a']);
  s.ended('a');
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a', 'b']);
});

test('[T28] runs that write in one folder go one at a time; other folders, and reading, go side by side', async () => {
  const s = setup({ maxActiveRuns: 5 });
  await ask(s, 'w1', { cwd: '/synthetic/shared', target: { targetId: 't1', writes: true } });
  await ask(s, 'w2', { cwd: '/synthetic/shared', target: { targetId: 't2', writes: true } });
  await ask(s, 'r1', { cwd: '/synthetic/shared', target: { targetId: 't3', writes: false } });
  await ask(s, 'w3', { cwd: '/synthetic/other', target: { targetId: 't4', writes: true } });
  await pause();
  assert.deepEqual(s.promptsStarted(), ['w1', 'r1', 'w3']);
  s.ended('w1');
  await pause();
  assert.deepEqual(s.promptsStarted(), ['w1', 'r1', 'w3', 'w2']);
});

test('[T28] a run that says nothing of what it writes counts as writing', async () => {
  const s = setup({ maxActiveRuns: 5 });
  await ask(s, 'a', { cwd: '/synthetic/shared' });
  await ask(s, 'b', { cwd: '/synthetic/shared' });
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a']);
});

test('[T28] a run waiting is told so, and what it hears from then on is under its one id', async () => {
  const s = setup({ maxActiveRuns: 1 });
  await ask(s, 'a');
  const b = await ask(s, 'b');
  await pause();
  assert.deepEqual(s.heard(b).map((e) => e.type), ['queued']);
  s.ended('a');
  await pause();
  s.of('b').say({ type: 'message_update', delta: 'x' });
  assert.deepEqual(s.heard(b).map((e) => e.type), ['queued', 'message_update']);
});

test('[T28] stopping a run that is waiting: it never starts, it says it stopped, and nothing else is touched', async () => {
  const s = setup({ maxActiveRuns: 1 });
  const a = await ask(s, 'a', { target: { targetId: 'ta' } });
  const b = await ask(s, 'b', { target: { targetId: 'tb' } });
  assert.equal(s.scheduler.cancelTargetRun('tb', b), true);
  await pause();
  assert.deepEqual(s.heard(b).map((e) => e.type), ['queued', 'run_end']);
  assert.equal(s.heard(b).at(-1).how, 'aborted');
  assert.deepEqual(s.stopped, []);
  assert.equal(s.heard(a).some((e) => e.type === 'run_end'), false);
  s.ended('a');
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a']);
});

test('[T28] stopping a run at work reaches that run only', async () => {
  const s = setup();
  const a = await ask(s, 'a', { target: { targetId: 'ta' } });
  await ask(s, 'b', { target: { targetId: 'tb' } });
  await pause();
  assert.equal(s.scheduler.cancelTargetRun('ta', a), true);
  assert.deepEqual(s.stopped, [s.of('a').runId]);
});

test('[T28] a stop that names the wrong target, or a run nobody knows, does nothing', async () => {
  const s = setup();
  const a = await ask(s, 'a', { target: { targetId: 'ta' } });
  await pause();
  assert.equal(s.scheduler.cancelTargetRun('tb', a), false);
  assert.equal(s.scheduler.cancelTargetRun('ta', 'no-such-run'), false);
  assert.deepEqual(s.stopped, []);
});

test('[T28] stopping before the runtime has said the run\'s id still stops it, once it does', async () => {
  const s = setup();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const realRun = s.runtime.run;
  s.runtime.run = async (req, onEvent) => { await held; return realRun(req, onEvent); };
  const a = await ask(s, 'a');
  await pause();
  assert.equal(s.scheduler.cancel(a), true);
  release();
  await pause();
  assert.deepEqual(s.stopped, [s.of('a').runId]);
});

test('[T28] an answer reaches the run it is for, under the id the runtime knows it by', async () => {
  const s = setup();
  const a = await ask(s, 'a', { target: { targetId: 'ta' } });
  const b = await ask(s, 'b', { target: { targetId: 'tb' } });
  await pause();
  // the same question id in two runs: two questions
  assert.equal(s.scheduler.answerApproval('ta', a, 'q-1', { confirmed: true }), true);
  assert.equal(s.scheduler.answerApproval('tb', b, 'q-1', { confirmed: false }), true);
  assert.deepEqual(s.answers, [
    { runId: s.of('a').runId, requestId: 'q-1', response: { confirmed: true } },
    { runId: s.of('b').runId, requestId: 'q-1', response: { confirmed: false } },
  ]);
});

test('[T28] an answer that names the wrong target, an unknown run, a waiting run or one over reaches nothing', async () => {
  const s = setup({ maxActiveRuns: 1 });
  const a = await ask(s, 'a', { target: { targetId: 'ta' } });
  const b = await ask(s, 'b', { target: { targetId: 'tb' } });
  await pause();
  assert.equal(s.scheduler.answerApproval('tb', a, 'q-1', { confirmed: true }), false);
  assert.equal(s.scheduler.answerApproval('ta', 'nobody', 'q-1', { confirmed: true }), false);
  assert.equal(s.scheduler.answerApproval('tb', b, 'q-1', { confirmed: true }), false);
  s.ended('a');
  await pause();
  assert.equal(s.scheduler.answerApproval('ta', a, 'q-1', { confirmed: true }), false);
  assert.deepEqual(s.answers, []);
});

test('[T28] what is not a string where one belongs is refused, and starts nothing', async () => {
  const s = setup();
  await assert.rejects(s.scheduler.enqueue({ runtime: 'codex', cwd: 42, prompt: 'x' }), /invalid/i);
  await assert.rejects(s.scheduler.enqueue({ runtime: 'codex', cwd: '/synthetic/a', prompt: 'x', target: { targetId: 7 } }), /invalid/i);
  await pause();
  assert.deepEqual(s.promptsStarted(), []);
  assert.equal(s.scheduler.cancelTargetRun(1, 2), false);
  assert.equal(s.scheduler.answerApproval(1, 2, 3, {}), false);
});

test('[T28] a failure of one leaves the other going, and its place is taken', async () => {
  const s = setup();
  const a = await ask(s, 'a');
  const b = await ask(s, 'b');
  await ask(s, 'c');
  await pause();
  s.of('a').say({ type: 'run_error', message: 'it broke' });
  s.of('a').say({ type: 'run_end', how: 'error', text: '' });
  await pause();
  assert.deepEqual(s.promptsStarted(), ['a', 'b', 'c']);
  assert.equal(s.heard(b).some((e) => e.type === 'run_end'), false);
  assert.equal(s.heard(a).at(-1).how, 'error');
});

test('[T28] a runtime that refuses to start: the run ends with that said, and the next starts', async () => {
  const s = setup({ maxActiveRuns: 1 });
  const realRun = s.runtime.run;
  let first = true;
  s.runtime.run = async (req, onEvent) => { if (first) { first = false; throw new Error('it is not installed'); } return realRun(req, onEvent); };
  const a = await ask(s, 'a');
  await ask(s, 'b');
  await pause();
  assert.deepEqual(s.heard(a).map((e) => e.type), ['run_error', 'run_end']);
  assert.match(s.heard(a)[0].message, /not installed/);
  assert.deepEqual(s.promptsStarted(), ['b']);
});

test('[T28] what comes after a run has ended reaches nobody, and starts nothing twice', async () => {
  const s = setup({ maxActiveRuns: 1 });
  const a = await ask(s, 'a');
  await ask(s, 'b');
  await pause();
  s.ended('a');
  const before = s.heard(a).length;
  s.of('a').say({ type: 'message_update' });
  s.ended('a');
  await pause();
  assert.equal(s.heard(a).length, before);
  assert.deepEqual(s.promptsStarted(), ['a', 'b']);
});

test('[T28] two runs in events out of order keep to their own', async () => {
  const s = setup();
  const a = await ask(s, 'a');
  const b = await ask(s, 'b');
  await pause();
  for (const [p, text] of [['b', 'b1'], ['a', 'a1'], ['a', 'a2'], ['b', 'b2']]) s.of(p).say({ type: 'message_update', text });
  assert.deepEqual(s.heard(a).map((e) => e.text), ['a1', 'a2']);
  assert.deepEqual(s.heard(b).map((e) => e.text), ['b1', 'b2']);
});
