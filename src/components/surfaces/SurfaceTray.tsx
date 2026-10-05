import { FileText } from 'lucide-react';
import { restoreSurface, useSurfaces } from '../../lib/documents/surface-store';

// Where surfaces that were put away wait: a row of names at the bottom of
// the container. A click brings one back to where it was.

export default function SurfaceTray() {
  const surfaces = useSurfaces((s) => s.surfaces);
  const away = surfaces.filter((s) => s.placement === 'minimized');
  if (away.length === 0) return null;
  return (
    <div className="absolute left-1/2 -translate-x-1/2 bottom-3 flex gap-1.5 max-w-[70%] overflow-x-auto" style={{ pointerEvents: 'auto' }} data-surface-tray>
      {away.map((s) => (
        <button key={s.surfaceId} onClick={() => restoreSurface(s.surfaceId)} data-surface-chip={s.surfaceId} title={s.title}
          className="shrink-0 max-w-[180px] flex items-center gap-1.5 bg-card/95 backdrop-blur border border-line rounded-lg px-2.5 py-1.5 shadow-sm text-xs text-ink hover:bg-wash transition-colors">
          <FileText size={12} strokeWidth={1.75} className="text-ink-muted shrink-0" />
          <span className="truncate">{s.title}</span>
        </button>
      ))}
    </div>
  );
}
