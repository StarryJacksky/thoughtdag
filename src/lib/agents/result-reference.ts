// One AI given another's answer, because the person said so. What it is given is one
// answer of the other task, named: it stays that answer whichever versions come after,
// it carries the words and not the other's native session or tools, and a newer answer
// is only said on the line. It is a line of the feedback kind (lib/feedback) that does
// not move when its target asks again.

import { useStore } from '../../store';
import { COLORS } from '../constants';
import type { ThoughtEdge, ThoughtNode } from '../../types';
import type { ExecutionTarget, RunEnvelope } from '../context/contracts';
import { answerIdAt, isFailedAnswer } from '../feedback';

export type ReferenceDepth = 'summary' | 'selected' | 'path';

/** A node's answers, by name. */
export function answerVersionsOf(node: ThoughtNode): { answerVersionId: string; index: number; failed: boolean }[] {
  return (node.data.responses ?? []).map((_, index) => ({ answerVersionId: answerIdAt(node, index), index, failed: isFailedAnswer(node, index) }));
}

/** Give a task one answer of another, at this depth. An answer that is not there, or is a failure's message, is refused. */
export function referenceAnswer(taskNodeId: string, sourceNodeId: string, answerVersionId: string, depth: ReferenceDepth): void {
  const state = useStore.getState();
  if (taskNodeId === sourceNodeId) throw new Error('a task does not refer to itself');
  const source = state.nodes.find((n) => n.id === sourceNodeId);
  if (!source || !state.nodes.some((n) => n.id === taskNodeId)) throw new Error('that task is not on the canvas');
  const answer = answerVersionsOf(source).find((v) => v.answerVersionId === answerVersionId);
  if (!answer) throw new Error('that task has no such answer');
  if (answer.failed) throw new Error('that answer is a failure');
  const now = new Date().toISOString();
  const feedback = { version: answer.index, versionId: answerVersionId, pinnedAt: now, fixed: true, depth };
  const others = state.edges.filter((e) => !(e.source === sourceNodeId && e.target === taskNodeId));
  const line: ThoughtEdge = {
    id: `reference-${sourceNodeId}-${taskNodeId}`,
    source: sourceNodeId, sourceHandle: 'branch',
    target: taskNodeId, targetHandle: 'left',
    type: 'smoothstep',
    style: { stroke: COLORS.feedback, strokeDasharray: '2 6', strokeWidth: 2.5, strokeLinecap: 'round' },
    animated: false,
    markerEnd: { type: 'arrowclosed' as const, color: COLORS.feedback, width: 16, height: 16 },
    data: { isCrossLink: true, feedback, createdAt: now },
  };
  state.pushHistory();
  useStore.setState({ edges: [...others, line] });
  state.pushHistory();
}

export interface InputDifference {
  targetId: string;
  label: string;
  model: string;
  effort: string | null;
  tools: string[];
  /** what this run is given and some other is not */
  added: string[];
  /** what some other run is given and this one is not */
  missing: string[];
}

/** What each of several prepared runs is given that the others are not, and what each runs on. */
export function comparePreparedRuns(runs: { target: ExecutionTarget; envelope: RunEnvelope }[]): InputDifference[] {
  const contentsOf = (run: { envelope: RunEnvelope }) => new Map(run.envelope.inputs.map((i) => [i.contentHash, i.inputId]));
  const all = runs.map(contentsOf);
  const everywhere = (hash: string) => all.every((c) => c.has(hash));
  // the same content is the same input whichever run names it
  const firstName = new Map<string, string>();
  for (const c of all) for (const [hash, id] of c) if (!firstName.has(hash)) firstName.set(hash, id);
  return runs.map((run, i) => ({
    targetId: run.target.targetId,
    label: run.target.label,
    model: run.envelope.runtime.model,
    effort: run.envelope.runtime.effort,
    tools: [...(run.envelope.policy.tools?.allow ?? [])],
    added: [...all[i]].filter(([hash]) => !everywhere(hash)).map(([, id]) => id),
    missing: [...firstName].filter(([hash]) => !all[i].has(hash)).map(([, id]) => id),
  }));
}
