import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { useStore } from '../../store';
import { toast } from '../../lib/ui-store';
import { fmt, useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import { shownStaleIds } from '../../lib/stale-judge';
import { writesFiles } from '../../lib/agents/target-model';
import { planReplay, runReplay, type ReplayPolicy } from '../../lib/context/replay-plan';

/**
 * Where an answer stands against what it was given: for an answer out of
 * date, what changed (which file, which answer upstream) and what can be
 * done (run this one again, run it and everything that reads it below in
 * order, or keep it as it is); and for the version shown, the files it read,
 * kept as they were then.
 */
export default function StaleSection({ nodeId }: { nodeId: string }) {
  const t = useT();
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const reasons = useStore((s) => s.staleReasons[nodeId]);
  const shown = useStore((s) => shownStaleIds(s).includes(nodeId));
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const [busy, setBusy] = useState(false);
  const below = useMemo(() => (shown ? planReplay([nodeId], 'downstream', { nodes, edges }).steps.length : 0), [shown, nodeId, nodes, edges]);
  if (!node) return null;
  const versionRun = node.data.runs?.[node.data.responseIndex];
  const files = (versionRun?.inputs ?? []).filter((i) => i.fileId && i.snapshotId.startsWith('snap_'));
  const questionOf = (id: string) => (nodes.find((n) => n.id === id)?.data.question ?? '').replace(/\s+/g, ' ').slice(0, 32);

  const replay = (policy: ReplayPolicy) => {
    setBusy(true);
    void runReplay(planReplay([nodeId], policy))
      .then(({ waiting }) => { if (waiting.length > 0) toast('info', fmt(t('replay.waiting'), { n: waiting.length }), 9000); })
      .finally(() => setBusy(false));
  };
  const button = (policy: ReplayPolicy, label: string) => (
    <button onClick={() => replay(policy)} disabled={busy || isViewerMode} data-replay={policy}
      className="px-2 py-0.5 rounded-md border border-line text-xs text-ink-muted hover:text-ink hover:border-line-strong disabled:opacity-40 transition-colors">
      {label}
    </button>
  );

  return (
    <>
      {shown && reasons && (
        <div className="mt-2 rounded-lg border border-amber-300/60 bg-amber-50/60 dark:bg-amber-900/10 px-2.5 py-2 text-xs" data-stale-reasons={nodeId}>
          <div className="text-amber-700 dark:text-amber-400 mb-1">{t('run.stale.title')}</div>
          <ul className="flex flex-col gap-0.5 text-ink-muted mb-1.5">
            {reasons.map((r, i) => (
              <li key={i} data-stale-reason={r.kind}>
                {r.kind === 'input-changed' ? fmt(t('run.stale.inputChanged'), { name: r.name })
                  : r.kind === 'input-lost' ? fmt(t('run.stale.inputLost'), { name: r.name })
                    : r.via.length > 0 ? fmt(t('run.stale.upstreamChangedVia'), { what: r.via.map((id) => questionOf(id) || t('run.stale.removed')).join(t('run.policyJoin')) })
                      : t('run.stale.upstreamChanged')}
              </li>
            ))}
          </ul>
          {writesFiles(node.data)
            ? <p className="text-ink-muted" data-stale-waits>{t('run.stale.waits')}</p>
            : (
              <div className="flex flex-wrap gap-1.5">
                {button('target-only', t('run.stale.rerun'))}
                {below > 1 && button('downstream', fmt(t('run.stale.downstream'), { n: below }))}
                {button('keep', t('run.stale.keep'))}
              </div>
            )}
        </div>
      )}
      {versionRun?.route && (
        <p className="mt-1.5 text-2xs text-ink-faint" data-version-route={versionRun.route.action}>
          {fmt(t('route.line'), { how: t(versionRun.route.action === 'resume' ? 'route.resume' : 'route.fresh'), why: t(`route.reason.${versionRun.route.reason}` as Parameters<typeof t>[0]) })}
        </p>
      )}
      {files.length > 0 && (
        <p className="mt-1.5 flex items-start gap-1 text-2xs text-ink-faint" data-version-inputs={nodeId}>
          <History size={11} strokeWidth={1.75} className="mt-px shrink-0" />
          <span>{fmt(t('run.versionInputs'), { names: files.map((f) => f.name ?? f.fileId).join(t('run.policyJoin')) })}</span>
        </p>
      )}
    </>
  );
}
