// What a run's events come to on the page. The host numbers them (runtime/execution/
// run-journal.cjs). An event of a run nobody is listening for yet (the shell has not
// said the run's id) is kept and told once someone is; the same event twice is told
// once; what comes after a run has ended reaches nobody. Runs are never mixed up: a
// number or an id means something only within its run. A host that does not number
// its events still has tool calls and questions told once, by their own ids.

type RunEvent = Record<string, unknown> & { type: string };
export type IngestResult = 'delivered' | 'held' | 'duplicate' | 'ended';

const ONCE: Record<string, (e: RunEvent) => unknown> = {
  tool_execution_start: (e) => e.toolCallId,
  tool_execution_end: (e) => e.toolCallId,
  question: (e) => e.id,
  question_answered: (e) => e.id,
};

interface Entry {
  handler: ((event: RunEvent) => void) | null;
  held: RunEvent[];
  lastSeq: number;
  seen: Set<string>;
}

export function createEventLedger({ maxHeldEvents = 2000, maxHeldRuns = 32, maxEnded = 200 } = {}) {
  const runs = new Map<string, Entry>();
  const ended = new Set<string>();
  const entryOf = (runId: string): Entry => {
    let entry = runs.get(runId);
    if (!entry) { entry = { handler: null, held: [], lastSeq: 0, seen: new Set() }; runs.set(runId, entry); }
    return entry;
  };
  /** Whether this event was told already. */
  const repeated = (entry: Entry, event: RunEvent): boolean => {
    if (typeof event.seq === 'number') {
      if (event.seq <= entry.lastSeq) return true;
      entry.lastSeq = event.seq;
      return false;
    }
    const id = ONCE[event.type]?.(event);
    if (id === undefined || id === null || id === '') return false;
    const key = `${event.type}:${String(id)}`;
    if (entry.seen.has(key)) return true;
    entry.seen.add(key);
    return false;
  };
  return {
    /** One event from the host. */
    ingestEvent(runId: string, event: RunEvent): IngestResult {
      if (ended.has(runId)) return 'ended';
      const entry = entryOf(runId);
      if (repeated(entry, event)) return 'duplicate';
      if (entry.handler) { entry.handler(event); return 'delivered'; }
      entry.held.push(event);
      if (entry.held.length > maxHeldEvents) entry.held.shift();
      // runs of another window of this app are heard here too, and nobody here will claim them
      const waiting = [...runs].filter(([, e]) => !e.handler);
      if (waiting.length > maxHeldRuns) runs.delete(waiting[0][0]);
      return 'held';
    },
    /** Someone listens for this run from now on, and is told first what came before. */
    register(runId: string, handler: (event: RunEvent) => void): void {
      const entry = entryOf(runId);
      entry.handler = handler;
      const waited = entry.held;
      entry.held = [];
      for (const event of waited) handler(event);
    },
    /** The run has ended: whatever comes for it now reaches nobody. */
    finish(runId: string): void {
      runs.delete(runId);
      ended.add(runId);
      if (ended.size > maxEnded) ended.delete(ended.values().next().value as string);
    },
    heldFor: (runId: string): number => runs.get(runId)?.held.length ?? 0,
  };
}
