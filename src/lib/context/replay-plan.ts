// Replaying what is out of date, as the person chooses: only the answers
// chosen, or those and everything that read them below, in the order they
// depend on each other; or none, keeping the old answers as they are. A
// replay writes new versions beside the old ones, which stay as they were.
// An agent that may write files is never set off by a replay: its step
// waits for the person, and so does every step that reads what it would
// write. What may run is looked at when the plan is made and again as each
// step starts: the person can change a task while it waits. A step counts as
// run only when it wrote a new answer; otherwise what reads it does not run.

import { isFeedback } from '../feedback';
import { writesFiles } from '../agents/target-model';
import { canvasVisit } from '../workspace/canvas-visit';
import { useStore } from '../../store';
import { taskIdentity } from '../../store/slices/evaluator';
import type { RerunOutcome } from '../../store/types';
import type { ThoughtEdge, ThoughtNode } from '../../types';
import type { StaleReason } from './staleness';
import { detectStale } from './staleness';

export type ReplayPolicy = 'target-only' | 'downstream' | 'keep';

export interface ReplayStep {
  nodeId: string;
  /** run it again, or wait for the person to run it (it may write files) */
  action: 'rerun' | 'needs-approval';
  /** the steps of the plan it reads, which run before it */
  after: string[];
  /** why it is in the plan: what changed, for an answer that is out of date itself */
  reasons: StaleReason[];
  /** the AI it was planned for (a target and its settings, or a bare model) */
  planned: string;
}

export interface ReplayPlan {
  policy: ReplayPolicy;
  targets: string[];
  steps: ReplayStep[];
  /** the answers kept as they are */
  kept: string[];
}

const NOT_ASKED = new Set(['note', 'file', 'link', 'frame']);
const asks = (n: ThoughtNode | undefined): n is ThoughtNode => !!n && !!n.data.question && !NOT_ASKED.has(n.data.stepKind ?? '') && !n.data.resourceRef;

/**
 * The plan for replaying `targets`. `downstream` adds every answer that reads them, through any
 * wire (a feedback line carries one fixed answer and is not followed). The steps are in the order
 * the answers read each other; a step is after every step of the plan it reads, near or far.
 */
export function planReplay(targets: string[], policy: ReplayPolicy, graph: { nodes: ThoughtNode[]; edges: ThoughtEdge[] } = useStore.getState()): ReplayPlan {
  const { nodes, edges } = graph;
  const nodeOf = (id: string) => nodes.find((n) => n.id === id);
  const wires = edges.filter((e) => !isFeedback(e));
  const wanted = [...new Set(targets)].filter((id) => asks(nodeOf(id)));
  if (policy === 'keep') return { policy, targets: wanted, steps: [], kept: wanted };

  const inPlan = new Set(wanted);
  if (policy === 'downstream') {
    const queue = [...wanted];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of wires) if (e.source === id && !inPlan.has(e.target) && asks(nodeOf(e.target))) { inPlan.add(e.target); queue.push(e.target); }
    }
  }
  // what each step reads among the steps, near or far
  const readsFrom = (id: string): string[] => {
    const seen = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of wires) if (e.target === at && !seen.has(e.source)) { seen.add(e.source); queue.push(e.source); }
    }
    return [...seen].filter((x) => x !== id && inPlan.has(x));
  };
  const after = new Map([...inPlan].map((id) => [id, readsFrom(id)]));
  // in the order they read each other; the canvas's order between those that do not
  const order: string[] = [];
  const placed = new Set<string>();
  const byCanvas = nodes.map((n) => n.id).filter((id) => inPlan.has(id));
  while (order.length < byCanvas.length) {
    const ready = byCanvas.filter((id) => !placed.has(id) && after.get(id)!.every((x) => placed.has(x)));
    if (ready.length === 0) { for (const id of byCanvas) if (!placed.has(id)) { order.push(id); placed.add(id); } break; } // a loop: what is left, as it stands
    for (const id of ready) { order.push(id); placed.add(id); }
  }
  const reasons = detectStale({ nodes, edges });
  const steps = order.map((id) => ({
    nodeId: id,
    action: writesFiles(nodeOf(id)!.data) ? 'needs-approval' as const : 'rerun' as const,
    after: order.filter((x) => after.get(id)!.includes(x)),
    reasons: reasons.filter((r) => r.nodeId === id),
    planned: taskIdentity(nodeOf(id)!.data),
  }));
  return { policy, targets: wanted, steps, kept: [] };
}

export interface ReplayOptions {
  /** asked before each round of steps: true stops the replay there */
  stopped?: () => boolean;
  /** told after each round, with the steps run so far */
  onProgress?: (ran: string[]) => void;
}

/** What became of a step that was asked to run and wrote no answer. */
export interface ReplayFailure { nodeId: string; status: Exclude<RerunOutcome['status'], 'answered' | 'needs-approval'> }

/**
 * Carry a plan out, on the canvas it was made on. Steps run once every step they read has written its
 * answer, those that are ready together. A step that waits for the person is not run, nor one that has
 * changed since it was planned, and neither is a step that reads one. A step that wrote no answer (it
 * was not sent, failed or was stopped, or was running already) is said to have failed, and what reads it
 * waits; branches that read nothing of it go on. Keeping marks the kept answers as kept, for the
 * staleness they have now. Resolves with what ran, what waits, and what failed if anything did.
 */
export async function runReplay(plan: ReplayPlan, { stopped = () => false, onProgress }: ReplayOptions = {}): Promise<{ ran: string[]; waiting: string[]; failed?: ReplayFailure[] }> {
  const store = useStore.getState();
  if (plan.policy === 'keep') {
    store.recomputeStaleness();
    const { staleFps } = useStore.getState();
    store.setStaleVerdicts(Object.fromEntries(plan.kept.filter((id) => staleFps[id]).map((id) => [id, { fp: staleFps[id], p: 0, changed: [], kept: true }])));
    return { ran: [], waiting: [] };
  }
  const visit = canvasVisit();
  const waiting = new Set<string>();
  const holdBack = (nodeId: string) => { waiting.add(nodeId); for (const s of plan.steps) if (s.after.includes(nodeId)) waiting.add(s.nodeId); };
  for (const step of plan.steps) if (step.action === 'needs-approval') holdBack(step.nodeId);
  const ran: string[] = [];
  const failed: ReplayFailure[] = [];
  const over = (nodeId: string) => ran.includes(nodeId) || waiting.has(nodeId) || failed.some((f) => f.nodeId === nodeId);
  while (!stopped()) {
    const open = plan.steps.filter((s) => !over(s.nodeId));
    if (open.length === 0) break;
    if (canvasVisit() !== visit) { for (const s of open) waiting.add(s.nodeId); break; } // the person left: this plan is not for what is on show now
    const ready = open.filter((s) => s.after.every((x) => ran.includes(x)));
    if (ready.length === 0) break;
    const starting = ready.filter((s) => {
      const data = useStore.getState().nodes.find((n) => n.id === s.nodeId)?.data;
      if (data && taskIdentity(data) === s.planned && !writesFiles(data)) return true;
      holdBack(s.nodeId);
      return false;
    });
    const outcomes = await Promise.all(starting.map((s) => useStore.getState().rerunNode(s.nodeId, { auto: true, expect: s.planned })));
    starting.forEach((s, i) => {
      const { status } = outcomes[i];
      if (status === 'answered') ran.push(s.nodeId);
      else if (status === 'needs-approval') holdBack(s.nodeId);
      else { failed.push({ nodeId: s.nodeId, status }); holdBack(s.nodeId); waiting.delete(s.nodeId); }
    });
    onProgress?.([...ran]);
  }
  useStore.getState().recomputeStaleness();
  return { ran, waiting: plan.steps.map((s) => s.nodeId).filter((id) => waiting.has(id)), ...(failed.length > 0 ? { failed } : {}) };
}
