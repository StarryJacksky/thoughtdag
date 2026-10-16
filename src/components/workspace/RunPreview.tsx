import { useMemo, useState } from 'react';
import { ChevronRight, FlaskConical, Hammer } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { fmt, useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import { isTask, runModeOf, setRunMode, type RunMode } from '../../lib/agents/targets';
import { AGENT_RUNTIMES, runtimeOf } from '../../lib/agents/agent-runtime';
import { previewRun } from '../../lib/context/prepare-run';
import { capabilitiesOf, verifyPolicy } from '../../lib/context/policy';
import StaleSection from './StaleSection';

/**
 * What a run of a task is given, and what it runs under, before it is
 * sent: the mode (at work, or research: its inputs and its question and
 * nothing else), what that mode means for the AI it runs on, and its inputs
 * and what is left out, read from the canvas as it is. A task at work on an
 * agent says that the agent's tools can read more than its inputs; a task
 * set to research on an agent that is not known to keep to its inputs says
 * that it will not be sent. Below: whether its answer is out of date, and
 * the files the version shown read (StaleSection).
 */
export default function RunPreview({ nodeId }: { nodeId: string }) {
  const t = useT();
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const [open, setOpen] = useState(false);
  // read only while it is open: building a context on every change of the canvas is not free
  const preview = useMemo(() => (open ? previewRun(nodeId, nodes, edges) : null), [open, nodeId, nodes, edges]);
  if (!isTask(node)) return null;

  const target = node.data.target;
  const mode = runModeOf(target);
  const runtime = target ? target.runtime : runtimeOf(node.data.model ?? selectedModel ?? '');
  const agent = target ? target.kind === 'agent' : runtime !== null;
  // what the verdict will be when it is sent: the policy's shape is all the check reads of it
  const verdict = verifyPolicy({
    mode,
    runtime: { kind: agent ? 'agent' : 'provider', runtime, connectionRef: '', model: '', effort: null, capabilityVersion: null },
    policy: {
      read: { scope: mode === 'research' ? 'inputs-only' : 'workspace', inputIds: [] },
      write: { scope: agent && mode === 'workspace' ? 'workspace' : 'none' },
      tools: { allow: [], mcpServers: [] },
      network: agent && mode === 'workspace' ? 'on' : 'off',
      recall: 'off',
      budget: { maxInputTokens: 0, reservedOutputTokens: 0, maxToolCalls: 0, maxWallTimeSeconds: 0 },
    },
  }, capabilitiesOf(runtime));
  const runtimeLabel = runtime ? AGENT_RUNTIMES[runtime].label : '';
  const line = mode === 'research'
    ? (agent ? (verdict.ok ? null : fmt(t('run.preview.researchAgentBlocked'), { runtime: runtimeLabel })) : t('run.preview.researchApi'))
    : (verdict.notice === 'workspace-readable' ? t('run.preview.workspaceReadable') : null);
  const choose = (next: RunMode) => { if (next !== mode) setRunMode(nodeId, next); };
  const button = (value: RunMode, label: string, title: string, Icon: typeof Hammer) => (
    <button
      onClick={() => choose(value)}
      disabled={isViewerMode}
      title={title}
      aria-pressed={mode === value}
      data-run-mode={value}
      className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-xs transition-colors ${mode === value ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:text-ink'}`}
    >
      <Icon size={12} strokeWidth={1.75} />{label}
    </button>
  );
  const sizeOf = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

  return (
    <div className="px-4 py-3 border-b border-line" data-run-preview={nodeId}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-2xs uppercase tracking-wide text-ink-faint">{t('run.preview.mode')}</span>
        <div className="flex items-center gap-0.5 rounded-lg border border-line p-0.5" role="group">
          {button('workspace', t('run.preview.workspace'), t('run.preview.workspaceTitle'), Hammer)}
          {button('research', t('run.preview.research'), t('run.preview.researchTitle'), FlaskConical)}
        </div>
      </div>
      {line && <p className={`text-xs leading-relaxed ${verdict.ok ? 'text-ink-muted' : 'text-red-600'}`} data-run-notice={verdict.ok ? (verdict.notice ?? mode) : 'blocked'}>{line}</p>}
      <StaleSection nodeId={nodeId} />
      <button onClick={() => setOpen((o) => !o)} className="mt-1.5 flex items-center gap-1 text-2xs uppercase tracking-wide text-ink-faint hover:text-ink" data-run-preview-toggle aria-expanded={open}>
        <ChevronRight size={12} strokeWidth={1.75} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {t('run.preview.title')}
      </button>
      {preview && (
        <div className="mt-1.5 flex flex-col gap-1 text-xs" data-run-inputs>
          {preview.inputs.length === 0 && <span className="text-ink-faint">{t('run.preview.noInputs')}</span>}
          {preview.inputs.map((item) => (
            <div key={`${item.nodeId}:${item.attachmentId}`} className="flex items-center gap-1.5 text-ink" data-run-input={item.nodeId}>
              <span className="flex-1 truncate">{item.name}</span>
              {item.part === 'passage' && <span className="text-2xs text-accent">{t('run.preview.passage')}</span>}
              {item.bytes > 0 && <span className="text-2xs font-mono text-ink-faint">{sizeOf(item.bytes)}</span>}
            </div>
          ))}
          {preview.excluded.map((item) => (
            <div key={`x:${item.nodeId}:${item.attachmentId}`} className="flex items-center gap-1.5 text-ink-faint" data-run-excluded={item.nodeId}>
              <span className="flex-1 truncate line-through">{item.name}</span>
              <span className="text-2xs">{t('run.preview.excluded')}</span>
            </div>
          ))}
          {node.data.lastRun && <span className="text-2xs text-ink-faint">{fmt(t('run.preview.lastRun'), { n: node.data.lastRun.inputs.length })}</span>}
        </div>
      )}
    </div>
  );
}
