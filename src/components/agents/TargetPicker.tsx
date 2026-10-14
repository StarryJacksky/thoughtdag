import { useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, PanelRightOpen, Sparkles } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { ensureAgentsFresh, useModels, type ModelInfo } from '../../lib/use-models';
import { isAgentModel, runtimeOf } from '../../lib/agents/agent-runtime';
import { createTarget, describeTarget, newTask, retarget, templateFor } from '../../lib/agents/targets';
import { openTaskSurface } from '../../lib/documents/surface-store';
import { freeSpot } from '../workspace/actions';
import { useT, fmt } from '../../i18n';
import { useSendCheck } from './use-send-check';

// Which AI a task runs on, shown on the task and chosen there. The list
// has two groups that are never mixed: agents (a runtime with one of its
// models) and models reached through a provider's API. A model of some
// family called through its API is listed under the API models, by its own
// name; it is not that family's agent.
//
// Choosing here gives this task a target of its own, made at that moment.
// The toolbar's model is only what a task with no target yet will be bound
// to when it is first sent, and the chip says so.

/** How one model of the list reads: the same words a target made from it would carry. */
const describe = (id: string) => describeTarget({ model: id, effort: null, kind: runtimeOf(id) ? 'agent' : 'provider', runtime: runtimeOf(id) });

function AiList({ current, onPick }: { current?: string; onPick: (model: ModelInfo) => void }) {
  const t = useT();
  const data = useModels();
  useEffect(() => { ensureAgentsFresh(); }, []);
  const models = data?.models ?? [];
  const agents = models.filter((m) => isAgentModel(m.id));
  const api = models.filter((m) => !isAgentModel(m.id));
  const row = (m: ModelInfo) => {
    const d = describe(m.id);
    return (
      <button key={m.id} onClick={() => onPick(m)} data-target-option={m.id} data-target-group={d.group}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs rounded-md transition-colors ${m.id === current ? 'bg-accent/10 text-ink' : 'text-ink hover:bg-wash'}`}>
        <span className="flex-1 min-w-0 truncate">{d.group === 'agent' ? `${d.runtime} · ${d.model}` : d.model}</span>
        {m.id === current && <Check size={12} strokeWidth={2} className="text-accent shrink-0" />}
      </button>
    );
  };
  if (models.length === 0) return <p className="px-2.5 py-2 text-2xs text-ink-faint leading-snug" data-target-none>{t('target.noModels')}</p>;
  return (
    <div className="max-h-72 overflow-y-auto nowheel">
      {agents.length > 0 && <p className="px-2.5 pt-1.5 pb-0.5 text-2xs text-ink-faint" data-target-heading="agent">{t('target.groupAgents')}</p>}
      {agents.map(row)}
      {api.length > 0 && <p className="px-2.5 pt-2 pb-0.5 text-2xs text-ink-faint" data-target-heading="api">{t('target.groupApi')}</p>}
      {api.map(row)}
    </div>
  );
}

/** Close a little menu when the person presses outside it or presses Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', escape, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', escape, true); };
  }, [open, close]);
  return ref;
}

/** The chip on a task: the AI it is bound to, and the way to give it another. */
export default function TargetPicker({ nodeId }: { nodeId: string }) {
  const t = useT();
  const target = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.target);
  const pin = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.model);
  const question = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.question ?? '');
  const toolbar = useUiStore((s) => s.selectedModel);
  const models = useModels();
  const check = useSendCheck(nodeId);
  const [open, setOpen] = useState(false);
  const menu = useDismiss(open, () => setOpen(false));

  // a task with no target yet says what it will be bound to when it is first sent
  const pending = target ? null : (pin ?? toolbar ?? models?.default ?? null);
  const label = target ? describeTarget(target).label : pending ? describe(pending).label : t('target.none');
  const efforts = target?.kind === 'agent' ? (models?.models.find((m) => m.id === target.model)?.efforts ?? []) : [];
  const tone = !check.ok ? 'border-amber-300 text-amber-800 bg-amber-50' : target ? 'border-line text-ink bg-card' : 'border-dashed border-line text-ink-muted bg-card';

  return (
    <div ref={menu} className="relative nodrag nopan" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-1">
        <button onClick={() => setOpen((o) => !o)} data-target-chip={target ? 'bound' : 'unbound'} data-target-model={target?.model ?? ''}
          title={!check.ok ? t(check.reason === 'no-model' ? 'target.noModelTitle' : 'target.unavailableTitle') : target ? t('target.boundTitle') : t('target.unboundTitle')}
          className={`flex items-center gap-1.5 max-w-[280px] rounded-full border px-2.5 py-1 text-2xs shadow-sm transition-colors hover:border-accent ${tone}`}>
          <Bot size={12} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate" data-target-label>{label}</span>
          {!target && pending && <span className="shrink-0 text-ink-faint">{t('target.whenSent')}</span>}
          <ChevronDown size={11} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
        </button>
        <button onClick={() => openTaskSurface(nodeId, question.trim().slice(0, 48) || fmt(t('target.panelTitle'), { ai: label }))} data-task-open-panel title={t('target.openPanel')}
          className="w-6 h-6 rounded-full border border-line bg-card text-ink-faint hover:text-accent hover:border-accent flex items-center justify-center shadow-sm transition-colors">
          <PanelRightOpen size={12} strokeWidth={1.75} />
        </button>
      </div>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-72 bg-card border border-line rounded-xl shadow-lg p-1.5" data-target-menu>
          <p className="px-2.5 pt-1 pb-1.5 text-2xs text-ink-muted leading-snug border-b border-line/60 mb-1">{t('target.menuHint')}</p>
          <AiList current={target?.model} onPick={(m) => { retarget(nodeId, { model: m.id }); if (!m.efforts?.length) setOpen(false); }} />
          {efforts.length > 0 && target && (
            <div className="flex flex-wrap items-center gap-1 px-2.5 pt-2 pb-1 mt-1 border-t border-line/60" data-target-efforts>
              <span className="text-2xs text-ink-faint mr-1">{t('target.effort')}</span>
              {efforts.map((level) => (
                <button key={level} onClick={() => retarget(nodeId, { model: target.model, effort: level })} data-target-effort={level}
                  className={`px-2 py-0.5 rounded-full text-2xs transition-colors ${target.effort === level ? 'bg-accent text-white' : 'bg-wash text-ink-muted hover:text-ink'}`}>{level}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The palette's "new AI task": pick an AI, and an empty task bound to it
 * is put on the canvas. The target is made from the defaults as they are
 * at that moment.
 */
export function NewTaskButton({ flowPosAt }: { flowPosAt: (point: { x: number; y: number } | null) => { x: number; y: number } }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menu = useDismiss(open, () => setOpen(false));
  return (
    <div ref={menu} className="relative">
      <button onClick={() => setOpen((o) => !o)} title={t('target.newTaskTitle')} data-new-task
        className="w-9 h-9 rounded-lg flex items-center justify-center text-accent hover:bg-accent/10 transition-colors">
        <Sparkles size={17} strokeWidth={1.75} />
      </button>
      {open && (
        <div className="absolute left-full top-0 ml-2 z-50 w-72 bg-card border border-line rounded-xl shadow-lg p-1.5" data-new-task-menu>
          <p className="px-2.5 pt-1 pb-1.5 text-2xs text-ink-muted leading-snug border-b border-line/60 mb-1">{t('target.newTaskHint')}</p>
          {/* beside what is already there, never on top of it: a card that covers another hides it */}
          <AiList onPick={(m) => { newTask(createTarget(templateFor(m.id)), freeSpot(flowPosAt(null))); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}
