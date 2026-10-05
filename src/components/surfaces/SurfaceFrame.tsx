import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { FileText, Maximize2, Minimize2, Minus, PanelLeft, PanelRight, X } from 'lucide-react';
import { closeSurface, focusSurface, restoreSurface, setPlacement, shownRect, updateRect, useSurfaces, TITLE_BAR_HEIGHT, type Rect, type Surface } from '../../lib/documents/surface-store';
import { useT } from '../../i18n';

// One surface: a frame with a title bar to move it by, a corner to resize it
// by, and the ways to dock it, fill the container with it, put it away or
// close it. It takes the pointer only while it is being dragged, and what is
// typed inside it goes no further than the frame: the canvas's own
// shortcuts never hear it.

interface Props {
  surface: Surface;
  zIndex: number;
  children: ReactNode;
}

export default function SurfaceFrame({ surface, zIndex, children }: Props) {
  const t = useT();
  const container = useSurfaces((s) => s.container);
  // the drag under way: where the pointer and the frame were when it began
  const drag = useRef<{ kind: 'move' | 'resize'; pointerId: number; x: number; y: number; rect: Rect } | null>(null);
  const shown = shownRect(surface, container);
  if (!shown) return null;
  const floating = surface.placement === 'floating';

  const begin = (kind: 'move' | 'resize') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !floating) return;
    // a press on one of the bar's buttons is a click on the button, not the start of a drag
    if (kind === 'move' && (e.target as HTMLElement).closest('button')) return;
    drag.current = { kind, pointerId: e.pointerId, x: e.clientX, y: e.clientY, rect: surface.rect };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const [dx, dy] = [e.clientX - d.x, e.clientY - d.y];
    updateRect(surface.surfaceId, d.kind === 'move'
      ? { ...d.rect, x: d.rect.x + dx, y: d.rect.y + dy }
      : { ...d.rect, width: d.rect.width + dx, height: d.rect.height + dy });
  };
  const end = (e: ReactPointerEvent<HTMLElement>) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const dragging = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

  const button = 'w-6 h-6 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-wash transition-colors';
  const big = surface.placement === 'maximized';

  return (
    <div
      data-surface={surface.surfaceId}
      data-surface-placement={surface.placement}
      onPointerDown={() => focusSurface(surface.surfaceId)}
      // what is typed in a surface is the document's: none of it reaches the canvas's shortcuts
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
      className={`absolute flex flex-col bg-card border border-line shadow-lg overflow-hidden ${floating ? 'rounded-xl' : ''}`}
      style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height, zIndex, pointerEvents: 'auto' }}
    >
      <div
        data-surface-titlebar
        onPointerDown={begin('move')}
        {...dragging}
        onDoubleClick={() => (big ? restoreSurface(surface.surfaceId) : setPlacement(surface.surfaceId, 'maximized'))}
        className={`shrink-0 flex items-center gap-1.5 pl-3 pr-1.5 border-b border-line/70 bg-wash/60 select-none ${floating ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{ height: TITLE_BAR_HEIGHT, touchAction: 'none' }}
      >
        <FileText size={13} strokeWidth={1.75} className="text-ink-muted shrink-0" />
        <span className="text-xs text-ink truncate flex-1 min-w-0" data-surface-title>{surface.title}</span>
        <button className={button} title={t('surface.dockLeft')} data-surface-dock-left onClick={() => (surface.placement === 'left' ? restoreSurface(surface.surfaceId) : setPlacement(surface.surfaceId, 'left'))}><PanelLeft size={13} strokeWidth={1.75} /></button>
        <button className={button} title={t('surface.dockRight')} data-surface-dock-right onClick={() => (surface.placement === 'right' ? restoreSurface(surface.surfaceId) : setPlacement(surface.surfaceId, 'right'))}><PanelRight size={13} strokeWidth={1.75} /></button>
        <button className={button} title={t('surface.minimize')} data-surface-minimize onClick={() => setPlacement(surface.surfaceId, 'minimized')}><Minus size={13} strokeWidth={1.75} /></button>
        <button className={button} title={t(big ? 'surface.restore' : 'surface.maximize')} data-surface-maximize onClick={() => (big ? restoreSurface(surface.surfaceId) : setPlacement(surface.surfaceId, 'maximized'))}>
          {big ? <Minimize2 size={12} strokeWidth={1.75} /> : <Maximize2 size={12} strokeWidth={1.75} />}
        </button>
        <button className={`${button} hover:text-red-500`} title={t('surface.close')} data-surface-close onClick={() => closeSurface(surface.surfaceId)}><X size={14} strokeWidth={1.75} /></button>
      </div>
      {children}
      {floating && (
        <div
          data-surface-resize
          onPointerDown={begin('resize')}
          {...dragging}
          className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize"
          style={{ touchAction: 'none' }}
        />
      )}
    </div>
  );
}
