// How much a run may be given. A model whose window is known is held to it, less what
// its answer needs. For one whose window is not known (an agent's, a server's own) the
// person says, once, for all of those; until they do nothing is claimed and nothing is
// stopped. This counts what the application sends, as estimated (utils.countTokens); an
// agent's own instructions and its session's history come on top and cannot be counted.

import { contextLengthFor } from '../runtime-providers';
import { useUiStore } from '../ui-store';
import { modelsNow } from '../use-models';
import type { Budget } from './contracts';

export const RESERVED_OUTPUT_TOKENS = 8_192;

export function inputBudgetFor(modelId: string | null | undefined): Pick<Budget, 'maxInputTokens' | 'inputLimitFrom'> {
  const known = modelId ? contextLengthFor(modelId) ?? modelsNow()?.models.find((m) => m.id === modelId)?.contextLength : undefined;
  if (known) return { maxInputTokens: Math.max(1, known - RESERVED_OUTPUT_TOKENS), inputLimitFrom: 'model-window' };
  const said = useUiStore.getState().inputBudget;
  return said ? { maxInputTokens: said, inputLimitFrom: 'person' } : { maxInputTokens: 0, inputLimitFrom: 'unset' };
}
