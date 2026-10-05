import { useEffect, useRef } from 'react';
import { setContainer, useSurfaces } from '../../lib/documents/surface-store';
import DocumentBody from './DocumentBody';
import SurfaceFrame from './SurfaceFrame';
import SurfaceTray from './SurfaceTray';

// The layer the surfaces live in. It spans the canvas area and is not there
// for the pointer: only the frames themselves take clicks, so the canvas,
// its panels and the question box stay as reachable with ten documents open
// as with none. Nothing here covers the app or waits to be dismissed.

export default function SurfaceManager() {
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
          <DocumentBody documentId={surface.documentId} surfaceId={surface.surfaceId} />
        </SurfaceFrame>
      ))}
      <SurfaceTray />
    </div>
  );
}
