// How a run stands (docs: 工程计划 §9). `prepared` until it is sent; what has ended
// stays ended, whatever comes late. A request whose receipt never came is `unknown`:
// it may have left, so it is looked up and never sent again.

import type { RunState } from '../context/contracts';

export type RunStep =
  | { kind: 'submitting' }
  | { kind: 'accepted' }
  | { kind: 'asked' }
  /** `open`: how many questions of the run are still open */
  | { kind: 'answered'; open: number }
  | { kind: 'stopping' }
  | { kind: 'no-receipt' }
  | { kind: 'ended'; how: string };

const ENDED = new Set<RunState>(['completed', 'failed', 'cancelled']);
export const hasEnded = (state: RunState): boolean => ENDED.has(state);
const stateOfEnd = (how: string): RunState => (how === 'end' ? 'completed' : how === 'aborted' ? 'cancelled' : 'failed');

export function transitionRun(state: RunState, step: RunStep): RunState {
  if (ENDED.has(state)) return state;
  if (step.kind === 'ended') return stateOfEnd(step.how);
  if (state === 'unknown') return state;
  switch (step.kind) {
    case 'submitting': return state === 'prepared' ? 'starting' : state;
    case 'accepted': return state === 'starting' ? 'running' : state;
    case 'asked': return state === 'cancelling' ? state : 'awaiting-approval';
    case 'answered': return state === 'awaiting-approval' && step.open === 0 ? 'running' : state;
    case 'stopping': return 'cancelling';
    case 'no-receipt': return 'unknown';
    default: return state;
  }
}

type EventsSince = NonNullable<DesktopAgentsBridge['eventsSince']>;

/**
 * How a run stands whose record never said how it ended: what the host that ran it says, if it is
 * still there. What cannot be found out is `unknown`, and nothing is sent again because of it.
 */
export async function reconcileRun(record: { state: RunState; nativeBinding: { hostRunId?: string | null } | null }, eventsSince: EventsSince | undefined): Promise<RunState> {
  if (ENDED.has(record.state)) return record.state;
  const hostRunId = record.nativeBinding?.hostRunId;
  if (!hostRunId || !eventsSince) return 'unknown';
  try {
    const { state, events } = await eventsSince(hostRunId, 0);
    if (state === 'running') return 'running';
    const end = events.find((e) => e.type === 'run_end');
    return state === 'ended' && end ? stateOfEnd(String(end.how ?? 'end')) : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The runs of a workspace whose record never said how they ended, as far as they can be found out:
 * asked of the host that ran them, and nothing is sent again. Answers those it could not find out about.
 */
export async function runsNotKnownToHaveEnded(reported: { runs: { runId: string; state: string; recorded: string; nativeBinding?: { hostRunId?: string } | null }[] }, eventsSince: EventsSince | undefined): Promise<string[]> {
  const notKnown: string[] = [];
  for (const run of reported.runs) {
    if (run.state !== 'unknown') continue;
    const now = await reconcileRun({ state: run.recorded as RunState, nativeBinding: run.nativeBinding ?? null }, eventsSince);
    if (now === 'unknown') notKnown.push(run.runId);
  }
  return notKnown;
}
