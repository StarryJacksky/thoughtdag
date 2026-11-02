import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useT, fmt } from '../../i18n';
import { comparePreparedRuns, type InputDifference } from '../../lib/agents/result-reference';
import { prepareTargetRun, type PreparedTargetRun } from '../../lib/context/prepare-target-run';
import { useStore } from '../../store';
import { useProjects } from '../../store/projects';

type Row = { nodeId: string; question: string; difference?: InputDifference; blocked?: string; names: Map<string, string>; sent?: boolean };

/**
 * What several tasks would each be given, side by side, and what differs. Preparing sends nothing:
 * each is sent by its own button, by the person, one at a time. Runs that cannot be prepared say why.
 */
export default function TargetPreviewCompare({ nodeIds, onClose }: { nodeIds: string[]; onClose: () => void }) {
  const t = useT();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      const graphId = useProjects.getState().activeId ?? 'canvas';
      const found: (Row & { prepared?: PreparedTargetRun })[] = [];
      for (const nodeId of nodeIds) {
        const node = useStore.getState().nodes.find((n) => n.id === nodeId);
        if (!node?.data.target) { found.push({ nodeId, question: node?.data.question ?? '', blocked: t('run.blocked.no-target'), names: new Map() }); continue; }
        try {
          const prepared = await prepareTargetRun(graphId, nodeId, node.data.target.revision);
          found.push({ nodeId, question: node.data.question, prepared, names: new Map(prepared.envelope.inputs.map((i) => [i.inputId, i.displayName])) });
        } catch (e) {
          found.push({ nodeId, question: node.data.question, blocked: e instanceof Error ? e.message : String(e), names: new Map() });
        }
      }
      const ready = found.filter((r) => r.prepared);
      const differences = comparePreparedRuns(ready.map((r) => r.prepared!));
      ready.forEach((r, i) => { r.difference = differences[i]; });
      const every = new Map(ready.flatMap((r) => [...r.names]));
      for (const r of found) r.names = every;
      if (current) setRows(found);
    })();
    return () => { current = false; };
  }, [nodeIds, t]);

  const send = (nodeId: string) => {
    setRows((now) => now?.map((r) => (r.nodeId === nodeId ? { ...r, sent: true } : r)) ?? now);
    void useStore.getState().rerunNode(nodeId, {});
  };
  const named = (row: Row, ids: string[]) => ids.map((id) => row.names.get(id) ?? id).join(', ');

  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 w-[640px] max-w-[90vw] max-h-[70vh] overflow-auto bg-card border border-line rounded-xl shadow-lg p-4 space-y-3" data-compare-runs-panel>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{t('compare.title')}</span>
        <button onClick={onClose} className="text-ink-faint hover:text-ink" title={t('common.close')}><X size={14} strokeWidth={2} /></button>
      </div>
      <p className="text-xs text-ink-muted">{t('compare.note')}</p>
      {!rows && <p className="text-xs text-ink-faint">{t('compare.preparing')}</p>}
      {rows?.map((row) => (
        <div key={row.nodeId} className="border border-line rounded-lg p-3 space-y-1 text-xs" data-compare-row={row.nodeId}>
          <div className="text-ink truncate">{row.question}</div>
          {row.blocked && <div className="text-red-500" data-compare-blocked>{row.blocked}</div>}
          {row.difference && (
            <>
              <div className="text-ink-muted" data-compare-model>{[row.difference.label, row.difference.effort].filter(Boolean).join(' · ')}{row.difference.tools.length ? ` · ${row.difference.tools.join(', ')}` : ''}</div>
              {row.difference.added.length > 0 && <div data-compare-added>{fmt(t('compare.onlyHere'), { names: named(row, row.difference.added) })}</div>}
              {row.difference.missing.length > 0 && <div data-compare-missing>{fmt(t('compare.notHere'), { names: named(row, row.difference.missing) })}</div>}
              <button disabled={row.sent} onClick={() => send(row.nodeId)} data-compare-send
                className="mt-1 px-2 py-1 rounded-lg bg-accent text-white disabled:opacity-50">
                {row.sent ? t('compare.sent') : t('compare.send')}
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
