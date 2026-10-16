// Replaying what is out of date, as the person chooses: only the answers
// chosen, or those and everything that read them below, in the order they
// depend on each other; or none, keeping the old answers as they are. A
// replay writes new versions beside the old ones, which stay as they were.
// An agent that may write files is never set off by a replay: its step
// waits for the person, and so does every step that reads what it would
// write.

import { isFeedback } from '../feedback';
import { writesFiles } from '../agents/target-model';
import { useStore } from '../../store';
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
  }));
  return { policy, targets: wanted, steps, kept: [] };
}

export interface ReplayOptions {
  /** asked before each round of steps: true stops the replay there */
  stopped?: () => boolean;
  /** told after each round, with the steps run so far */
  onProgress?: (ran: string[]) => void;
}

/**
 * Carry a plan out. Steps run once every step they read has run, those that are ready together.
 * A step that waits for the person is not run, and neither is a step that reads one. Keeping
 * marks the kept answers as kept, for the staleness they have now. Resolves with what ran and
 * what waits.
 */
export async function runReplay(plan: ReplayPlan, { stopped = () => false, onProgress }: ReplayOptions = {}): Promise<{ ran: string[]; waiting: string[] }> {
  const store = useStore.getState();
  if (plan.policy === 'keep') {
    store.recomputeStaleness();
    const { staleFps } = useStore.getState();
    store.setStaleVerdicts(Object.fromEntries(plan.kept.filter((id) => staleFps[id]).map((id) => [id, { fp: staleFps[id], p: 0, changed: [], kept: true }])));
    return { ran: [], waiting: [] };
  }
  const waiting = new Set(plan.steps.filter((s) => s.action === 'needs-approval').map((s) => s.nodeId));
  for (const step of plan.steps) if (step.after.some((x) => waiting.has(x))) waiting.add(step.nodeId);
  const remaining = plan.steps.filter((s) => !waiting.has(s.nodeId));
  const ran: string[] = [];
  while (remaining.length > 0 && !stopped()) {
    const ready = remaining.filter((s) => s.after.every((x) => ran.includes(x) || !remaining.some((r) => r.nodeId === x)));
    if (ready.length === 0) break;
    await Promise.all(ready.map((s) => useStore.getState().rerunNode(s.nodeId, { auto: true })));
    for (const s of ready) { ran.push(s.nodeId); remaining.splice(remaining.indexOf(s), 1); }
    onProgress?.([...ran]);
  }
  useStore.getState().recomputeStaleness();
  return { ran, waiting: plan.steps.map((s) => s.nodeId).filter((id) => waiting.has(id)) };
}
