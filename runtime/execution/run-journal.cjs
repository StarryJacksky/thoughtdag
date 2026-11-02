// What the host keeps of a run while the page may not be listening: every event
// numbered in the order it came, for a page that was not there to ask for again,
// and whether the run is still under way. Kept in memory, for as long as the host
// lives; a run's record on disk (run-records.cjs) is what outlives it. The events
// of a run are bounded: when the oldest are let go, the answer says so.
'use strict';

const MAX_EVENTS = 5000;
const KEEP_ENDED = 20;

function createRunJournal({ maxEvents = MAX_EVENTS, keepEnded = KEEP_ENDED } = {}) {
  const runs = new Map(); // runId → { events, next, first, ended }
  const ended = [];
  const entryOf = (runId) => {
    let run = runs.get(runId);
    if (!run) { run = { events: [], next: 1, ended: false }; runs.set(runId, run); }
    return run;
  };
  return {
    /** Note one event of a run; answers the event as it is to be told: with its number. */
    note(runId, event) {
      const run = entryOf(runId);
      const told = { ...event, seq: run.next++ };
      run.events.push(told);
      if (run.events.length > maxEvents) run.events.shift();
      if (event.type === 'run_end' && !run.ended) {
        run.ended = true;
        ended.push(runId);
        while (ended.length > keepEnded) runs.delete(ended.shift());
      }
      return told;
    },
    /** The events after `after`, and how the run stands: `unknown` when this host knows nothing of it. */
    since(runId, after = 0) {
      const run = runs.get(runId);
      if (!run) return { state: 'unknown', events: [], complete: false };
      const events = run.events.filter((e) => e.seq > after);
      const first = run.events[0]?.seq ?? run.next;
      return { state: run.ended ? 'ended' : 'running', events, complete: first <= after + 1 };
    },
  };
}

module.exports = { createRunJournal };
