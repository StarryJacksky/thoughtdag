import { useEffect, useRef } from 'react';
import { FolderOpen } from 'lucide-react';
import { setContainer, useSurfaces, type Surface } from '../../lib/documents/surface-store';
import { revealFile } from '../../lib/workspace/client';
import type { ResourceRef } from '../../lib/workspace/contracts';
import { useT } from '../../i18n';
import ResourceReader from '../readers/ResourceReader';
import DocumentBody from './DocumentBody';
import SurfaceFrame from './SurfaceFrame';
import SurfaceTray from './SurfaceTray';

// The layer the surfaces live in. It spans the canvas area and is not there
// for the pointer: only the frames themselves take clicks, so the canvas,
// its panels and the question box stay as reachable with ten documents open
// as with none. Nothing here covers the app or waits to be dismissed.

interface Props {
  /** what a quote taken in a reader is handed to: the reference to the part, its words, and the file's name */
  onQuote?: (ref: ResourceRef, words: string, fileName: string) => void;
}

/** A file that could not be opened to type into: the surface says why, and what can be done about it. */
function NoticeBody({ surface }: { surface: Surface }) {
  const t = useT();
  return (
    <div className="flex-1 flex flex-col items-start gap-3 px-4 py-4" data-surface-notice={surface.notice}>
      <p className="text-xs text-ink-muted leading-relaxed">{t(surface.notice === 'too-large' ? 'surface.tooLargeToEdit' : 'surface.notText')}</p>
      <button onClick={() => void revealFile(surface.fileId).catch(() => {})} data-surface-reveal
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs text-ink bg-wash hover:bg-line/40 transition-colors">
        <FolderOpen size={12} strokeWidth={1.75} /> {t('workspace.reveal')}
      </button>
    </div>
  );
}

export default function SurfaceManager({ onQuote }: Props = {}) {
  const surfaces = useSurfaces((s) => s.surfaces);
  const order = useSurfaces((s) => s.order);
  const layer = useRef<HTMLDivElement>(null);

  // the surfaces live in this layer's coordinates: when it changes size they are brought back inside it
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const measure = () => { const box = el.getBoundingClientRect(); setContainer({ width: box.width, height: box.height }); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={layer} data-surface-layer className="absolute inset-0 z-30 overflow-hidden" style={{ pointerEvents: 'none' }}>
      {surfaces.map((surface) => (
        <SurfaceFrame key={surface.surfaceId} surface={surface} zIndex={1 + order.indexOf(surface.surfaceId)}>
          {surface.notice ? <NoticeBody surface={surface} />
            : surface.reading ? (
              <ResourceReader
                resourceRef={{ fileId: surface.fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }}
                name={surface.title}
                onQuote={onQuote ? (ref, words) => onQuote(ref, words, surface.title) : undefined}
              />
            ) : <DocumentBody documentId={surface.documentId} surfaceId={surface.surfaceId} kind={surface.kind === 'markdown' ? 'markdown' : 'text'} />}
        </SurfaceFrame>
      ))}
      <SurfaceTray />
    </div>
  );
}
