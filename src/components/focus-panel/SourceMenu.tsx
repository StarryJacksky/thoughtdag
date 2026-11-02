import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { listSourceRoots, type SourceRoot } from '../../lib/workspace/source-picker';

/** Where to attach from: a file from this computer, or a source that says why it cannot be used. */
export default function SourceMenu({ projectId, onLocal, onClose, className = '' }: { projectId: string; onLocal: () => void; onClose: () => void; className?: string }) {
  const t = useT();
  const [roots, setRoots] = useState<SourceRoot[]>([]);
  useEffect(() => {
    let current = true;
    void listSourceRoots(projectId).then((found) => { if (current) setRoots(found); });
    return () => { current = false; };
  }, [projectId]);
  return (
    <div data-source-menu className={`absolute z-30 w-64 bg-card border border-line rounded-lg shadow-lg p-1 text-xs ${className}`}
      onClick={(e) => e.stopPropagation()}>
      {roots.map((root) => (
        <button key={root.kind} data-source={root.kind} disabled={root.status !== 'ready'}
          onClick={() => { onLocal(); onClose(); }}
          className="w-full text-left px-2 py-1.5 rounded enabled:hover:bg-line disabled:opacity-60 disabled:cursor-not-allowed">
          <div className="text-ink">{t(root.displayName as Parameters<typeof t>[0])}</div>
          {root.blockedReason && <div data-source-blocked className="text-2xs text-ink-faint mt-0.5">{t(root.blockedReason as Parameters<typeof t>[0])}</div>}
        </button>
      ))}
    </div>
  );
}
