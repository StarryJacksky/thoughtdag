import { useEffect, useState } from 'react';
import { ArchiveRestore, File as FileIcon, Folder } from 'lucide-react';
import { listRecovery, newOperationId, restoreFromRecovery } from '../../lib/workspace/client';
import type { RecoveryItem } from '../../lib/workspace/contracts';
import { reloadTree, useWorkspacePanel } from '../../lib/workspace/session';
import { toast } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';

// The workspace's recovery area: files and folders that were trashed into
// the workspace's own records (a volume with no system trash) and can be
// put back where they were. What went to the system trash is not here: the
// system brings that back, and the files are recognized when it does.

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function RecoveryList({ workspaceId, canRestore }: { workspaceId: string; canRestore: boolean }) {
  const t = useT();
  const treeVersion = useWorkspacePanel((s) => s.treeVersion);
  const [items, setItems] = useState<RecoveryItem[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    listRecovery(workspaceId).then(
      (found) => { if (!stale) { setItems(found); setFailed(null); } },
      (e) => { if (!stale) setFailed(why(e)); },
    );
    return () => { stale = true; };
  }, [workspaceId, treeVersion]);

  const putBack = async (item: RecoveryItem) => {
    try {
      await restoreFromRecovery(workspaceId, item.receiptId, newOperationId());
      reloadTree();
      toast('success', fmt(t('workspace.restored'), { name: item.relativePath }));
    } catch (e) {
      toast('error', fmt(t('workspace.failed'), { why: why(e) }));
    }
  };

  if (failed) return <p className="px-3 py-3 text-2xs text-ink-faint leading-snug">{fmt(t('workspace.listFailed'), { why: failed })}</p>;
  if (items === null) return <p className="px-3 py-3 text-2xs text-ink-faint">{t('workspace.loading')}</p>;
  if (items.length === 0) return <p className="px-3 py-3 text-2xs text-ink-faint leading-snug" data-recovery-empty>{t('workspace.recoveryEmpty')}</p>;
  return (
    <div className="py-1" data-recovery-list>
      {items.map((item) => (
        <div key={item.receiptId} className="px-3 py-1.5 flex items-center gap-2 hover:bg-wash transition-colors" data-recovery-item={item.name}>
          {item.kind === 'folder' ? <Folder size={14} strokeWidth={1.75} className="text-ink-muted shrink-0" /> : <FileIcon size={13} strokeWidth={1.75} className="text-ink-faint shrink-0" />}
          <span className="flex-1 min-w-0">
            <span className="block text-xs text-ink truncate">{item.name}</span>
            <span className="block text-2xs text-ink-faint font-mono truncate" title={item.relativePath}>{fmt(t('workspace.wasAt'), { path: item.relativePath })}</span>
          </span>
          {canRestore && (
            <button onClick={() => void putBack(item)} title={t('workspace.restore')} data-recovery-restore
              className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-ink-faint hover:text-accent">
              <ArchiveRestore size={14} strokeWidth={1.75} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
