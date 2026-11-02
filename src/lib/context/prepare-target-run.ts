// A task's run, prepared from the target it is bound to: what it runs on, its mode,
// its tools and its effort are the target's, and nothing is read from what is set
// now. Planned for one revision of the target, it is not prepared for another. The
// target and the envelope are frozen from here: changing the model, the focus or the
// graph affects the next preparation only.

import { useStore } from '../../store';
import { runModeOf, selectionOf } from '../agents/target-model';
import type { ExecutionTarget, RunEnvelope } from './contracts';
import { prepareRun, RunBlocked } from './prepare-run';

export interface PreparedTargetRun {
  target: ExecutionTarget;
  envelope: RunEnvelope;
}

/** The tools a target allows its run: none in research, and none it was not made with. */
function toolsOf(target: ExecutionTarget) {
  if (runModeOf(target) === 'research') return { web: false, scholar: false, mcp: false };
  return { web: !!target.tools?.web, scholar: !!target.tools?.scholar, mcp: !!target.tools?.mcp };
}

export async function prepareTargetRun(graphId: string, taskNodeId: string, expectedTargetRevision: string): Promise<PreparedTargetRun> {
  const task = useStore.getState().nodes.find((n) => n.id === taskNodeId);
  const target = task?.data.target;
  if (!task || !target) throw new RunBlocked('no-target', taskNodeId, null, 'that task is bound to no AI');
  if (target.revision !== expectedTargetRevision) throw new RunBlocked('target-changed', taskNodeId, null, 'the AI of this task changed after the run was planned');
  const envelope = await prepareRun({
    graphId,
    targetNodeId: taskNodeId,
    question: task.data.question,
    mode: runModeOf(target),
    runtimeSelection: selectionOf(target, { model: target.model, effort: target.effort }),
    tools: toolsOf(target),
    recall: 'off',
  });
  return { target, envelope };
}
