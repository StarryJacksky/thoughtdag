// Surfaces: the frames documents are shown in, beside the canvas. A
// surface is a place and a manner of showing (floating, docked, maximized,
// put away) for one document. It holds none of the document's text: the
// text is in the document service, and a surface that is closed takes
// nothing with it.
//
// Positions are in the coordinates of the container the surfaces live in
// (the canvas area), not of the screen. Whatever is asked, a surface is
// never smaller than its smallest size and never somewhere its title bar
// cannot be taken hold of.

import { create } from 'zustand';
import type { SurfaceState } from '../workspace/contracts';
import { reconcileFile } from '../workspace/client';
import { documents } from './document-service';

export type Rect = SurfaceState['rect'];
export type Size = { width: number; height: number };
export type Placement = SurfaceState['placement'];
export type SurfaceKind = SurfaceState['kind'];

/** A surface as the page holds it: the contract's state, plus what it shows by name and where it goes back to. */
export interface Surface extends SurfaceState {
  fileId: string;
  title: string;
  /** where the surface was before it was maximized, docked or put away: what "restore" returns it to */
  back: { placement: Placement; rect: Rect } | null;
}

export const MIN_SURFACE: Size = { width: 360, height: 240 };
export const TITLE_BAR_HEIGHT = 36;
/** This much of a title bar's width stays inside the container, so the surface can always be dragged back. */
const HOLD = 96;
const DEFAULT_SIZE: Size = { width: 560, height: 440 };

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** `rect` made legal for a container: at least the smallest size, no larger than the container, its title bar within reach. */
export function fitRect(rect: Rect, container: Size): Rect {
  const width = Math.round(clamp(rect.width, MIN_SURFACE.width, container.width));
  const height = Math.round(clamp(rect.height, MIN_SURFACE.height, container.height));
  return {
    width,
    height,
    x: Math.round(clamp(rect.x, HOLD - width, container.width - HOLD)),
    y: Math.round(clamp(rect.y, 0, container.height - TITLE_BAR_HEIGHT)),
  };
}

/** Where a surface is drawn for the way it is placed; null when it is put away. */
export function shownRect(surface: Pick<Surface, 'placement' | 'rect'>, container: Size): Rect | null {
  switch (surface.placement) {
    case 'minimized': return null;
    case 'maximized': return { x: 0, y: 0, width: container.width, height: container.height };
    case 'left': case 'right': {
      // a docked surface takes one side at full height, and never more than half the container
      const width = Math.round(clamp(surface.rect.width, MIN_SURFACE.width, container.width / 2));
      return { x: surface.placement === 'left' ? 0 : container.width - width, y: 0, width, height: container.height };
    }
    default: return fitRect(surface.rect, container);
  }
}

interface SurfacesState {
  surfaces: Surface[];
  /** surface ids from the one furthest back to the one in front */
  order: string[];
  container: Size;
}

export const useSurfaces = create<SurfacesState>(() => ({ surfaces: [], order: [], container: { width: 1280, height: 800 } }));

const change = (surfaceId: string, patch: (s: Surface) => Partial<Surface>) => useSurfaces.setState((state) => ({
  surfaces: state.surfaces.map((s) => (s.surfaceId === surfaceId ? { ...s, ...patch(s) } : s)),
}));
const newSurfaceId = () => `surface_${crypto.randomUUID()}`;

/** Bring a surface in front of the others. */
export function focusSurface(surfaceId: string): void {
  useSurfaces.setState((state) => (state.order.at(-1) === surfaceId || !state.order.includes(surfaceId)
    ? state
    : { order: [...state.order.filter((id) => id !== surfaceId), surfaceId] }));
}

/**
 * Open a surface on a document. Resolves with its id. The document must
 * already be open for that id as a view (see `openFileSurface`, which does
 * both). `as` places it; otherwise it floats beside the surfaces already there.
 */
export function openSurface(documentId: string, kind: SurfaceKind, options: { surfaceId?: string; fileId?: string; title?: string; placement?: Placement; rect?: Rect } = {}): string {
  const surfaceId = options.surfaceId ?? newSurfaceId();
  useSurfaces.setState((state) => {
    const floating = state.surfaces.filter((s) => s.placement === 'floating').length;
    // each new surface a step down and across from the last, wrapping before it leaves the container
    const step = (floating % 8) * 28;
    const rect = fitRect(options.rect ?? { ...DEFAULT_SIZE, x: state.container.width - DEFAULT_SIZE.width - 24 - step, y: 64 + step }, state.container);
    const surface: Surface = { surfaceId, documentId, kind, placement: options.placement ?? 'floating', rect, fileId: options.fileId ?? '', title: options.title ?? '', back: null };
    return { surfaces: [...state.surfaces, surface], order: [...state.order, surfaceId] };
  });
  return surfaceId;
}

/** Move or resize a surface. What is asked for is made legal first. */
export function updateRect(surfaceId: string, rect: Rect): void {
  const { container } = useSurfaces.getState();
  change(surfaceId, () => ({ rect: fitRect(rect, container) }));
}

/**
 * Place a surface: floating, docked to a side, maximized, or put away. The
 * place it leaves is remembered once, from the last time it was floating or
 * docked, so that restoring a maximized or minimized surface returns it there.
 */
export function setPlacement(surfaceId: string, placement: Placement): void {
  change(surfaceId, (s) => {
    if (s.placement === placement) return {};
    if (placement === 'floating') return { placement, back: null };
    const transient = (p: Placement) => p === 'maximized' || p === 'minimized';
    // going from maximized to minimized (or back) keeps what was remembered before either
    const back = transient(s.placement) && s.back ? s.back : { placement: s.placement, rect: s.rect };
    return { placement, back: transient(placement) || s.placement === 'floating' ? back : s.back ?? back };
  });
  if (placement !== 'minimized') focusSurface(surfaceId);
}

/** Return a surface to where it was before it was maximized, docked or put away. */
export function restoreSurface(surfaceId: string): void {
  change(surfaceId, (s) => {
    if (!s.back) return { placement: 'floating' };
    // a docked surface that was maximized goes back to its dock, and still remembers where it floated
    const docked = s.back.placement === 'left' || s.back.placement === 'right';
    return { placement: s.back.placement, rect: s.back.rect, back: docked ? { placement: 'floating', rect: s.back.rect } : null };
  });
  focusSurface(surfaceId);
}

/** Close a surface. Its view of the document is closed with it; the file is not touched. */
export function closeSurface(surfaceId: string): void {
  useSurfaces.setState((state) => ({ surfaces: state.surfaces.filter((s) => s.surfaceId !== surfaceId), order: state.order.filter((id) => id !== surfaceId) }));
  void documents.closeView(surfaceId);
}

/** The container the surfaces live in changed size: every surface is brought back within it. */
export function setContainer(container: Size): void {
  if (container.width <= 0 || container.height <= 0) return;
  useSurfaces.setState((state) => ({ container, surfaces: state.surfaces.map((s) => ({ ...s, rect: fitRect(s.rect, container) })) }));
}

/** The kind of surface a file of this name opens in. */
export function surfaceKindOf(name: string): SurfaceKind {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
  return 'text';
}

/**
 * Show a file in a surface. One surface per file: a file that already has
 * one gets it brought to the front. Resolves with the surface's id.
 */
export async function openFileSurface(fileId: string, options: { placement?: Placement; rect?: Rect } = {}): Promise<string> {
  const existing = useSurfaces.getState().surfaces.find((s) => s.fileId === fileId);
  if (existing) {
    if (existing.placement === 'minimized') restoreSurface(existing.surfaceId); else focusSurface(existing.surfaceId);
    return existing.surfaceId;
  }
  const surfaceId = newSurfaceId();
  const model = await documents.open(fileId, surfaceId);
  // someone else may have opened the same file while it was being read
  const raced = useSurfaces.getState().surfaces.find((s) => s.fileId === fileId);
  if (raced) { void documents.closeView(surfaceId); focusSurface(raced.surfaceId); return raced.surfaceId; }
  const title = documents.status(model.documentId)?.name ?? fileId;
  return openSurface(model.documentId, surfaceKindOf(title), { surfaceId, fileId, title, ...options });
}

// ── the layout of a canvas's surfaces ──────────────────────────────────
// Which files a canvas had open and where, kept by file identity so that
// it can be put back after the app is closed. It says where things were;
// it never holds what any file says.

const layoutKey = (canvasId: string) => `thoughtdag.surfaces.${canvasId}`;
interface SavedSurface { fileId: string; placement: Placement; rect: Rect; back: Surface['back'] }

/** Remember the open surfaces as this canvas's layout. */
export function saveLayout(canvasId: string): void {
  const { surfaces, order } = useSurfaces.getState();
  const saved: SavedSurface[] = order
    .map((id) => surfaces.find((s) => s.surfaceId === id))
    .filter((s): s is Surface => !!s && !!s.fileId)
    .map((s) => ({ fileId: s.fileId, placement: s.placement, rect: s.rect, back: s.back }));
  try {
    if (saved.length === 0) localStorage.removeItem(layoutKey(canvasId)); else localStorage.setItem(layoutKey(canvasId), JSON.stringify(saved));
  } catch { /* no storage: the layout is not remembered */ }
}

/** Open again what this canvas had open, where it was. A file that is no longer there is left out. */
export async function restoreLayout(canvasId: string): Promise<void> {
  let saved: SavedSurface[] = [];
  try { saved = JSON.parse(localStorage.getItem(layoutKey(canvasId)) ?? '[]'); } catch { /* nothing to put back */ }
  if (!Array.isArray(saved)) return;
  for (const entry of saved) {
    if (!entry || typeof entry.fileId !== 'string' || !entry.rect) continue;
    try {
      const record = await reconcileFile(entry.fileId);
      if (record.status === 'missing' || record.status === 'ambiguous') continue;
      const surfaceId = await openFileSurface(entry.fileId, { placement: entry.placement, rect: entry.rect });
      if (entry.back) change(surfaceId, () => ({ back: entry.back }));
    } catch { /* the file, or its workspace, is not there any more */ }
  }
}

/** Close every surface: the canvas is being left. Their documents are saved or kept as drafts by the document service. */
export function closeAllSurfaces(): void {
  for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
}
