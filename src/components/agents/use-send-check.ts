import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { useModels } from '../../lib/use-models';
import { checkSend, type SendCheck } from '../../lib/agents/target-model';

/**
 * Whether a question can be sent for this task now, kept up to date: it
 * changes when the task's target does, when the toolbar's model does, and
 * when the list of models that can be reached arrives.
 */
export function useSendCheck(nodeId: string): SendCheck {
  const target = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.target);
  const model = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.model);
  // read so that a change of the toolbar's pick is seen; `checkSend` reads it itself
  useUiStore((s) => s.selectedModel);
  const known = useModels();
  // nothing known yet of the models: nothing is held back on a guess
  if (!known) return { ok: true };
  return checkSend({ target, model }, { models: known.models, serverDefault: known.default });
}
