// Who runs when. A run is asked for and answered with an id at once; it starts when
// nothing stands in its way: at most `maxActiveRuns` at a time, one per target, one
// writer per native session and per folder (reading runs go beside each other and
// beside a writer). Runs wait in the order they were asked, and none overtakes an
// earlier one it is in the way of. What a run says, a stop and an answer all go by
// its id and reach that run only; what comes after it has ended reaches nobody.
//
// Both hosts run their agents through this (desktop/main.js, runtime/agents/http.cjs).
'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_MAX_ACTIVE = 2;
const KEEP_ENDED = 200;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The native session a run writes to, when it goes on in one: by the session's id, so that two names of one file are one session. */
const sessionOf = (sessionPath) => {
  if (typeof sessionPath !== 'string' || !sessionPath) return null;
  const ids = sessionPath.match(UUID);
  return ids ? ids[ids.length - 1].toLowerCase() : sessionPath;
};

function checked(req) {
  const fail = (what) => { throw new TypeError(`invalid run request: ${what}`); };
  if (!req || typeof req !== 'object') fail('not an object');
  if (typeof req.cwd !== 'string' || !req.cwd) fail('cwd');
  const target = req.target;
  if (target !== undefined && target !== null) {
    if (typeof target !== 'object' || typeof target.targetId !== 'string' || !target.targetId) fail('target');
    if (target.writes !== undefined && typeof target.writes !== 'boolean') fail('target.writes');
  }
  return req;
}

function createTargetScheduler({ runtimeFor, onEvent, maxActiveRuns = Number(process.env.TD_MAX_ACTIVE_RUNS) || DEFAULT_MAX_ACTIVE, newId = randomUUID }) {
  const runs = new Map();  // id → run
  const waiting = [];      // runs not started, oldest first
  const active = new Set();
  const over = [];
  const tell = (run, event) => { try { onEvent({ runId: run.id, event }); } catch { /* nobody to tell */ } };

  /** What a run holds while it runs. */
  const claimsOf = (req) => ({
    targetId: req.target?.targetId ?? null,
    session: `${req.runtime ?? ''}:${sessionOf(req.sessionPath) ?? ''}`,
    hasSession: !!sessionOf(req.sessionPath),
    // what does not say it only reads counts as writing
    writesIn: req.target?.writes === false ? null : req.cwd,
  });
  const inTheWay = (a, b) => (a.targetId !== null && a.targetId === b.targetId)
    || (a.hasSession && b.hasSession && a.session === b.session)
    || (a.writesIn !== null && a.writesIn === b.writesIn);

  function pump() {
    for (let i = 0; i < waiting.length && active.size < maxActiveRuns; i++) {
      const run = waiting[i];
      const blocked = [...active].some((other) => inTheWay(run.claims, other.claims)) || waiting.slice(0, i).some((other) => inTheWay(run.claims, other.claims));
      if (blocked) continue;
      waiting.splice(i, 1);
      i -= 1;
      start(run);
    }
  }

  function finish(run) {
    if (run.ended) return;
    run.ended = true;
    active.delete(run);
    over.push(run.id);
    while (over.length > KEEP_ENDED) runs.delete(over.shift());
    pump();
  }

  function start(run) {
    active.add(run);
    run.started = true;
    let runtime;
    const fail = (e) => {
      tell(run, { type: 'run_error', message: e instanceof Error ? e.message : String(e) });
      tell(run, { type: 'run_end', how: 'error', text: '' });
      finish(run);
    };
    try { runtime = runtimeFor(run.req.runtime); } catch (e) { fail(e); return; }
    run.runtime = runtime;
    Promise.resolve().then(() => runtime.run(run.req, ({ event }) => {
      if (run.ended) return;
      tell(run, event);
      if (event.type === 'run_end') finish(run);
    })).then((nativeId) => {
      run.nativeId = nativeId;
      // stopped before the runtime said its id: it is stopped now
      if (run.stopped && !run.ended) runtime.abort(nativeId);
    }, fail);
  }

  const cancel = (id) => {
    const run = typeof id === 'string' ? runs.get(id) : null;
    if (!run || run.ended) return false;
    run.stopped = true;
    if (!run.started) {
      waiting.splice(waiting.indexOf(run), 1);
      tell(run, { type: 'run_end', how: 'aborted', text: '' });
      finish(run);
      return true;
    }
    if (run.nativeId !== null) return run.runtime.abort(run.nativeId);
    return true;
  };
  const ofTarget = (targetId, id) => {
    if (typeof targetId !== 'string' || typeof id !== 'string') return null;
    const run = runs.get(id);
    return run && run.claims.targetId === targetId ? run : null;
  };
  const answer = (id, requestId, response) => {
    const run = typeof id === 'string' ? runs.get(id) : null;
    if (!run || run.ended || run.nativeId === null || typeof requestId !== 'string') return false;
    return run.runtime.answer(run.nativeId, requestId, response);
  };

  return {
    /** Ask for a run: answers its id at once. It starts when nothing stands in its way. */
    async enqueue(req) {
      checked(req);
      const run = { id: newId(), req, claims: claimsOf(req), runtime: null, nativeId: null, started: false, stopped: false, ended: false };
      runs.set(run.id, run);
      waiting.push(run);
      pump();
      if (!run.started) tell(run, { type: 'queued' });
      return run.id;
    },
    cancel,
    /** Stop a run, if it is this target's. */
    cancelTargetRun: (targetId, id) => (ofTarget(targetId, id) ? cancel(id) : false),
    /** Answer a question of a run, if the run is this one, at work, and this target's. */
    answerApproval: (targetId, id, requestId, response) => (ofTarget(targetId, id) ? answer(id, requestId, response) : false),
    answer,
  };
}

module.exports = { createTargetScheduler };
