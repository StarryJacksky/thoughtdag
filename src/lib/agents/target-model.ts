// What an AI target is, with nothing of the canvas in it: how one is made
// from a template, how it is named, and when it may be sent to. A target is
// the AI a task is bound to (an agent runtime with one of its models, or a
// model reached through a provider's API) with what it runs under. It is
// made once. The toolbar's model and the global effort are the template a
// new target is made from; changing them afterwards changes no target.
//
// This module is imported by the store's own modules, so it must not
// import the store or anything that needs the store while it loads. What
// reads or changes the canvas is in targets.ts.

import { validateRunDTO, type ExecutionTarget } from '../context/contracts';
import type { ModelInfo } from '../use-models';
import { useUiStore } from '../ui-store';
import { AGENT_RUNTIMES, agentTarget, runtimeOf } from './agent-runtime';

/** What of a target makes it the AI it is: two targets with the same settings are the same revision. */
const settingsOf = (t: ExecutionTarget) => [t.kind, t.runtime, t.connectionRef, t.model, t.effort, t.roleRef, t.memoryPolicyId, t.policyId, t.workspaceId, t.budgetId];
function revisionOf(target: ExecutionTarget): string {
  // a short, stable name for the settings (FNV-1a); it identifies them, it protects nothing
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify(settingsOf(target))) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193); }
  return `rev_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export interface TargetDescription {
  /** an agent runtime, or a model reached through a provider's API: the two are never listed under one name */
  group: 'agent' | 'api';
  /** the runtime's name, for an agent */
  runtime: string | null;
  /** the model's own name, without the door it is reached through */
  model: string;
  effort: string | null;
  /** one line for a card: runtime · model · effort, or model · API */
  label: string;
}

/**
 * How a target reads to a person. An agent is named by its runtime first
 * ("Claude Code · sonnet"); a model reached through an API is named by the
 * model and says that it is an API model ("claude-sonnet · API"). A model
 * of some family called through its API is not that family's agent, and
 * is never given the agent's name.
 */
export function describeTarget(target: Pick<ExecutionTarget, 'model' | 'effort' | 'kind' | 'runtime'>): TargetDescription {
  const agent = target.kind === 'agent' ? agentTarget(target.model) : null;
  if (agent) {
    const runtime = AGENT_RUNTIMES[agent.runtime].label;
    return { group: 'agent', runtime, model: agent.id, effort: target.effort, label: [runtime, agent.id, target.effort].filter(Boolean).join(' · ') };
  }
  const model = target.model.split('/').pop() || target.model;
  return { group: 'api', runtime: null, model, effort: null, label: `${model} · API` };
}

/**
 * The template for a new target: the given model, or the toolbar's, with
 * the settings the global defaults hold right now. Throws when there is no
 * model at all: a target is never made for "whatever is there later".
 */
export function templateFor(model?: string | null, more: { effort?: string | null } = {}): ExecutionTarget {
  const id = model ?? useUiStore.getState().selectedModel ?? '';
  if (!id) throw new Error('there is no model to make a target for');
  const runtime = runtimeOf(id);
  const kind: ExecutionTarget['kind'] = runtime ? 'agent' : 'provider';
  // effort is a setting of the agent runtimes; a model reached through an API has none here
  const effort = kind === 'agent' ? (more.effort !== undefined ? more.effort : (useUiStore.getState().agentEffort || null)) : null;
  const template: ExecutionTarget = {
    targetId: 'template',
    revision: '',
    label: '',
    kind,
    runtime,
    connectionRef: runtime ? `runtime:${runtime}` : `provider:${id.includes('/') ? id.slice(0, id.indexOf('/')) : 'default'}`,
    model: id,
    effort: effort || null,
    roleRef: null,
    memoryPolicyId: 'default',
    policyId: 'default',
    // the working folder belongs to the canvas today; a target of its own folder comes with per-target isolation
    workspaceId: 'canvas',
    budgetId: 'default',
  };
  return { ...template, revision: revisionOf(template), label: describeTarget(template).label };
}

/** A new target from a template: the template's settings under an identity of its own. */
export function createTarget(template: ExecutionTarget): ExecutionTarget {
  const settings = { ...template, effort: template.effort || null };
  const target: ExecutionTarget = { ...settings, targetId: `target_${crypto.randomUUID()}`, revision: revisionOf(settings), label: describeTarget(settings).label };
  const checked = validateRunDTO('ExecutionTarget', target);
  if (!checked.ok) throw new Error('that is not a target: ' + checked.errors.map((e) => `${e.path || '(the target)'} ${e.message}`).join('; '));
  return target;
}

/** What is known of the models that can be reached here; an empty list means nothing is known. */
export interface KnownModels { models: Pick<ModelInfo, 'id'>[]; serverDefault: string | null }
export type SendCheck = { ok: true } | { ok: false; reason: 'no-model' } | { ok: false; reason: 'unavailable'; model: string };

/**
 * Whether something can be sent for a task with this target and this pin.
 * No model anywhere is a reason not to send. A target whose API model is
 * known not to be among the reachable ones is another: it is not sent to
 * some other provider's model instead. An agent's models are the runtime's
 * to know, and are not judged from a list that may be a launch old.
 */
export function checkSend(task: { target?: ExecutionTarget; model?: string }, known: KnownModels): SendCheck {
  const model = task.target?.model ?? task.model ?? useUiStore.getState().selectedModel ?? known.serverDefault;
  if (!model) return { ok: false, reason: 'no-model' };
  const bound = task.target;
  if (bound && bound.kind === 'provider' && known.models.length > 0 && !known.models.some((m) => m.id === bound.model)) return { ok: false, reason: 'unavailable', model: bound.model };
  return { ok: true };
}
