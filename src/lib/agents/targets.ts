// AI tasks on the canvas and what is wired to them. A task is an ordinary
// question node bound to a target: the AI it runs on, fixed when the
// target was made. Several tasks for several AIs stand on one canvas; each
// reads what is wired to it by an edge, and nothing else.
//
// Wiring is only that. Connecting material to a task makes an edge: it
// sends nothing, runs nothing, and does nothing to the file the material
// stands for. Shared material is wired to each task by an edge of its own,
// so taking one away leaves the others. A connection that would make what
// a task reads depend on its own answer is refused.

import type { ExecutionTarget, TargetBinding } from '../context/contracts';
import type { ResourceRef } from '../workspace/contracts';
import { reconcileFile } from '../workspace/client';
import { attachResource, nodesOfFile } from '../workspace/graph-resource';
import { canvasVisit } from '../workspace/canvas-visit';
import { closesLoop } from '../feedback';
import { generateId } from '../../utils';
import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import type { ThoughtNode } from '../../types';
import { checkSend, createTarget as newTarget, templateFor, type KnownModels, type SendCheck } from './target-model';

export { describeTarget, templateFor, type SendCheck, type TargetDescription } from './target-model';

type Point = { x: number; y: number };
export type ConnectResult = { ok: true; edgeId: string; feedback?: true } | { ok: false; reason: 'loop' | 'not-a-task' | 'unknown' | 'left' };

/**
 * Where a gesture began: the canvas, and which opening of it. Work it
 * waits for (a file's identity, its record, its content) may come back
 * after another canvas was opened, or this one opened anew; it then does
 * nothing there. The canvas's id alone cannot tell, since a copy of a
 * canvas keeps the ids of its nodes.
 */
export interface Origin { canvasId: string | null; visit: number }
export const originNow = (): Origin => ({ canvasId: useProjects.getState().activeId, visit: canvasVisit() });
export const stillAt = (origin: Origin): boolean => canvasVisit() === origin.visit && useProjects.getState().activeId === origin.canvasId;

/** A node that asks: a question for an AI. Material (a note, a file, a link) and a step for a person are not. */
export const isTask = (node: ThoughtNode | undefined): node is ThoughtNode =>
  !!node && node.type === 'thought' && !node.data.resourceRef && (!node.data.stepKind || node.data.stepKind === 'prompt');

// targets that were made and are not on any node yet: `bindTarget` names a target by its id
const made = new Map<string, ExecutionTarget>();
const remember = (target: ExecutionTarget) => {
  made.set(target.targetId, target);
  if (made.size > 64) made.delete(made.keys().next().value as string);
  return target;
};

/** The target a task is bound to, if it has one yet. */
export function targetOf(nodeId: string): ExecutionTarget | undefined {
  return useStore.getState().nodes.find((n) => n.id === nodeId)?.data.target;
}

/** Every target a task of the open canvas is bound to, once each. */
export function targetsOnCanvas(): ExecutionTarget[] {
  const seen = new Map<string, ExecutionTarget>();
  for (const node of useStore.getState().nodes) if (node.data.target && !seen.has(node.data.target.targetId)) seen.set(node.data.target.targetId, node.data.target);
  return [...seen.values()];
}

const withTarget = (nodeId: string, target: ExecutionTarget) => useStore.setState((st) => ({
  // the pin is kept equal to the target's model: everything that follows a line's model follows the target
  nodes: st.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, target, model: target.model } } : n)),
}));

/** A new target from a template: the template's settings under an identity of its own, which `bindTarget` knows it by. */
export function createTarget(template: ExecutionTarget): ExecutionTarget {
  return remember(newTarget(template));
}

/**
 * Bind a task to a target, named by its id: one that some task of the
 * canvas already has, or one that was just made. The canvas must be the
 * one that is open and the node must be a task.
 */
export function bindTarget(binding: TargetBinding): void {
  if (useProjects.getState().activeId !== binding.graphId) throw new Error('that canvas is not the one that is open');
  const node = useStore.getState().nodes.find((n) => n.id === binding.taskNodeId);
  if (!isTask(node)) throw new Error('that node is not a task: only a question for an AI is bound to one');
  const target = targetsOnCanvas().find((t) => t.targetId === binding.targetId) ?? made.get(binding.targetId);
  if (!target) throw new Error('no such target: it was not made here');
  useStore.getState().pushHistory();
  withTarget(binding.taskNodeId, target);
  useStore.getState().pushHistory();
}

/** Put a new, empty task on the canvas, bound to `target`. The person types its question into it. Resolves with the node's id. */
export function newTask(target: ExecutionTarget, at: Point): string {
  remember(target);
  const st = useStore.getState();
  const id = generateId();
  st.setNodes([...st.nodes, {
    id, type: 'thought', position: at, dragHandle: '.drag-handle',
    data: {
      question: '', response: '', responses: [], responseIndex: -1,
      isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 0, highlights: [], highlightMode: 'tag',
      attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
      roleMode: 'inherit', isRoot: false, isBranch: false,
      model: target.model, target,
    },
  }]);
  st.pushHistory();
  return id;
}

/**
 * Give a task another AI. It gets a target of its own, made now: the
 * tasks it shared its old target with keep theirs. What is not said keeps
 * what the task had (its role, its policies); the effort is the one given,
 * else the task's own when the runtime stays the same, else the default.
 */
export function retarget(nodeId: string, to: { model: string; effort?: string | null }): ExecutionTarget {
  const node = useStore.getState().nodes.find((n) => n.id === nodeId);
  if (!isTask(node)) throw new Error('that node is not a task: only a question for an AI is bound to one');
  const was = node.data.target;
  const fresh = templateFor(to.model, to.effort !== undefined ? { effort: to.effort } : {});
  const sameRuntime = !!was && was.kind === fresh.kind && was.runtime === fresh.runtime;
  const target = createTarget({
    ...fresh,
    ...(to.effort === undefined && sameRuntime ? { effort: was!.effort } : {}),
    ...(was ? { roleRef: was.roleRef, memoryPolicyId: was.memoryPolicyId, policyId: was.policyId, workspaceId: was.workspaceId, budgetId: was.budgetId } : {}),
  });
  useStore.getState().pushHistory();
  withTarget(nodeId, target);
  useStore.getState().pushHistory();
  return target;
}

/** Whether a question can be sent for this task now (see `checkSend`). */
export function canSend(nodeId: string, known: KnownModels): SendCheck {
  const node = useStore.getState().nodes.find((n) => n.id === nodeId);
  return checkSend({ target: node?.data.target, model: node?.data.model }, known);
}

// ── wiring ─────────────────────────────────────────────────────────────

/**
 * Whether an edge from `sourceId` into `taskId` would close a loop: the
 * task's answer already reaches the source along lines that carry live
 * answers (a feedback line does not: what it carries is fixed). What a task
 * reads would then depend on what it answers.
 */
export function wouldLoop(sourceId: string, taskId: string): boolean {
  return closesLoop(sourceId, taskId, useStore.getState().edges);
}

/**
 * Wire a node on the canvas into a task: an edge, with the meaning edges
 * already have (material comes in whole; an earlier question and its
 * answer come in as a reference). Nothing is sent and nothing is run.
 * Wiring what is already wired is not an error: the edge that is there is
 * the answer. A connection that would close a loop is made as a feedback
 * line (lib/feedback): it holds one finished answer of the source, so what
 * the task reads does not depend on what it answers. Only a node wired into
 * itself is refused.
 */
export function connectNode(sourceId: string, taskId: string): ConnectResult {
  const { nodes } = useStore.getState();
  const source = nodes.find((n) => n.id === sourceId);
  const task = nodes.find((n) => n.id === taskId);
  if (!source || !task) return { ok: false, reason: 'unknown' };
  if (!isTask(task)) return { ok: false, reason: 'not-a-task' };
  if (sourceId === taskId) return { ok: false, reason: 'loop' };
  if (wouldLoop(sourceId, taskId)) {
    const edgeId = useStore.getState().addFeedbackLink(sourceId, taskId);
    return edgeId ? { ok: true, edgeId, feedback: true } : { ok: false, reason: 'unknown' };
  }
  const existing = () => useStore.getState().edges.find((e) => e.source === sourceId && e.target === taskId);
  if (!existing()) useStore.getState().addCrossLink(sourceId, taskId);
  const edge = existing();
  return edge ? { ok: true, edgeId: edge.id } : { ok: false, reason: 'unknown' };
}

/**
 * Wire references to files (or parts of files) into a task, and resolve
 * with the result for each. A file that already has a node on the canvas
 * is wired through that node; one that has none gets one, beside the
 * task. Each reference is wired to this task and to no other, on the
 * canvas, and in the opening of it, where the gesture began (`origin`):
 * after every wait that is checked again, and once it is not that canvas
 * nothing more is made or wired (`left`).
 */
export async function connectRefs(taskNodeId: string, refs: ResourceRef[], origin: Origin = originNow()): Promise<ConnectResult[]> {
  const results: ConnectResult[] = [];
  for (const [index, ref] of refs.entries()) {
    if (!stillAt(origin) || !origin.canvasId) { results.push({ ok: false, reason: 'left' }); continue; }
    const task = useStore.getState().nodes.find((n) => n.id === taskNodeId);
    if (!isTask(task)) { results.push({ ok: false, reason: task ? 'not-a-task' : 'unknown' }); continue; }
    const sameSelector = (n: ThoughtNode) => JSON.stringify(n.data.resourceRef?.selector) === JSON.stringify(ref.selector);
    let sourceId = nodesOfFile(ref.fileId).find(sameSelector)?.id;
    if (!sourceId) {
      try {
        const record = await reconcileFile(ref.fileId);
        if (!stillAt(origin)) { results.push({ ok: false, reason: 'left' }); continue; }
        sourceId = await attachResource(origin.canvasId, ref, { x: task.position.x - 420, y: task.position.y - 260 + index * 60 }, record);
      } catch { results.push({ ok: false, reason: 'unknown' }); continue; }
      if (!stillAt(origin)) { results.push({ ok: false, reason: 'left' }); continue; }
    }
    results.push(connectNode(sourceId, taskNodeId));
  }
  return results;
}

/**
 * Wire references into a task (the plan's name for it). Files that already
 * have a node are wired before this returns; the others are wired as soon
 * as their nodes are made. `connectRefs` is the same thing, to wait for.
 */
export function connectSelection(taskNodeId: string, refs: ResourceRef[]): void {
  const here: ResourceRef[] = [];
  const later: ResourceRef[] = [];
  for (const ref of refs) {
    const node = nodesOfFile(ref.fileId).find((n) => JSON.stringify(n.data.resourceRef?.selector) === JSON.stringify(ref.selector));
    if (node) { connectNode(node.id, taskNodeId); here.push(ref); } else later.push(ref);
  }
  if (later.length > 0) void connectRefs(taskNodeId, later).catch(() => {});
}
