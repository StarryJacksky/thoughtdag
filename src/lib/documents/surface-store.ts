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
//
// The surface in front is the one that is typed into: bringing a surface
// forward is also what sends the keys to it (see `active`, which the frames
// follow with the focus).
//
// Surfaces belong to the canvas that is open. A file that was asked to be
// opened on one visit of a canvas and is ready only after that visit is
// over opens nothing: its surface is not made, and the document that was
// opened for it is let go again.

import { create } from 'zustand';
import type { SurfaceState } from '../workspace/contracts';
import { canvasVisit } from '../workspace/canvas-visit';
import { reconcileFile, WorkspaceError } from '../workspace/client';
import { toast } from '../ui-store';
import { fmt, t } from '../../i18n';
import { documents } from './document-service';

export type Rect = SurfaceState['rect'];
export type Size = { width: number; height: number };
export type Placement = SurfaceState['placement'];
export type SurfaceKind = SurfaceState['kind'];

/** A surface as the page holds it: the contract's state, plus what it shows by name and where it goes back to. */
export interface Surface extends SurfaceState {
  fileId: string;
  /** the workspace the file is in: the page listens to it for as long as the surface is open, so that what is shown follows the file */
  workspaceId: string;
  title: string;
  /** where the surface was before it was maximized, docked or put away: what "restore" returns it to */
  back: { placement: Placement; rect: Rect } | null;
  /** the file is shown by a reader (a PDF, an image, a page, a Word document): there is no document to type into */
  reading: boolean;
  /** the file could not be opened to type into, and why; the surface says so instead of showing nothing */
  notice: 'too-large' | 'not-text' | null;
  /** the surface shows a task of the canvas (its question, its answer, what is wired to it): this is the task's node */
  taskNodeId: string | null;
  /** for a task: the opening of the canvas it is a task of (see canvas-visit). A copy of a canvas keeps its node ids: the id alone does not say which canvas */
  visit: number | null;
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
  /** the surface that was last brought forward, and a count that goes up each time one is: the frame of that surface takes the focus */
  active: { surfaceId: string | null; turn: number };
}

export const useSurfaces = create<SurfacesState>(() => ({ surfaces: [], order: [], container: { width: 1280, height: 800 }, active: { surfaceId: null, turn: 0 } }));

const change = (surfaceId: string, patch: (s: Surface) => Partial<Surface>) => useSurfaces.setState((state) => ({
  surfaces: state.surfaces.map((s) => (s.surfaceId === surfaceId ? { ...s, ...patch(s) } : s)),
}));
const newSurfaceId = () => `surface_${crypto.randomUUID()}`;

/** Bring a surface in front of the others. It is the one that is typed into from then on. */
export function focusSurface(surfaceId: string): void {
  useSurfaces.setState((state) => {
    if (!state.order.includes(surfaceId)) return state;
    const active = { surfaceId, turn: (state.active?.turn ?? 0) + 1 };
    return state.order.at(-1) === surfaceId ? { active } : { active, order: [...state.order.filter((id) => id !== surfaceId), surfaceId] };
  });
}

/**
 * Open a surface on a document. Resolves with its id. The document must
 * already be open for that id as a view (see `openFileSurface`, which does
 * both). `as` places it; otherwise it floats beside the surfaces already there.
 */
export function openSurface(documentId: string, kind: SurfaceKind, options: { surfaceId?: string; fileId?: string; workspaceId?: string; title?: string; placement?: Placement; rect?: Rect; reading?: boolean; notice?: Surface['notice']; taskNodeId?: string; visit?: number } = {}): string {
  const surfaceId = options.surfaceId ?? newSurfaceId();
  useSurfaces.setState((state) => {
    const floating = state.surfaces.filter((s) => s.placement === 'floating').length;
    // each new surface a step down and across from the last, wrapping before it leaves the container
    const step = (floating % 8) * 28;
    const rect = fitRect(options.rect ?? { ...DEFAULT_SIZE, x: state.container.width - DEFAULT_SIZE.width - 24 - step, y: 64 + step }, state.container);
    const surface: Surface = { surfaceId, documentId, kind, placement: options.placement ?? 'floating', rect, fileId: options.fileId ?? '', workspaceId: options.workspaceId ?? '', title: options.title ?? '', back: null, reading: options.reading ?? false, notice: options.notice ?? null, taskNodeId: options.taskNodeId ?? null, visit: options.visit ?? null };
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

/**
 * Close a surface. Its view of the document is closed with it; the file is
 * not touched. What was typed is saved or kept as a draft by the document
 * service. When neither could be done the document stays open, the person
 * is told, and the surface comes back with the text in it, unless the
 * canvas itself is being left (`leaving`) or was left meanwhile: then the
 * document waits in the background and is tried again by itself.
 */
export function closeSurface(surfaceId: string, how: { leaving?: boolean } = {}): void {
  const closed = useSurfaces.getState().surfaces.find((s) => s.surfaceId === surfaceId);
  const visit = canvasVisit();
  useSurfaces.setState((state) => ({ surfaces: state.surfaces.filter((s) => s.surfaceId !== surfaceId), order: state.order.filter((id) => id !== surfaceId) }));
  void documents.closeView(surfaceId).then((result) => {
    if (!result.held) return;
    toast('error', fmt(t('surface.notKept'), { name: closed?.title || documents.status(result.documentId)?.name || '' }), 12000);
    if (how.leaving || canvasVisit() !== visit) return;
    const placement = !closed || closed.placement === 'minimized' ? 'floating' : closed.placement;
    void openFileSurface(result.fileId, { placement, ...(closed ? { rect: closed.rect } : {}) }).catch(() => {});
  }).catch(() => {});
}

/** The container the surfaces live in changed size: every surface is brought back within it. */
export function setContainer(container: Size): void {
  if (container.width <= 0 || container.height <= 0) return;
  useSurfaces.setState((state) => ({ container, surfaces: state.surfaces.map((s) => ({ ...s, rect: fitRect(s.rect, container) })) }));
}

const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

/** The kind of surface a file of this name opens in. */
export function surfaceKindOf(name: string): SurfaceKind {
  const extension = extensionOf(name);
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
  if (extension === 'html' || extension === 'htm') return 'html';
  return 'text';
}

/** Whether a file of this name is shown by a reader instead of being opened to type into. */
export const isReadOnly = (name: string): boolean => surfaceKindOf(name) === 'pdf' || surfaceKindOf(name) === 'image' || surfaceKindOf(name) === 'html' || extensionOf(name) === 'docx';

/**
 * Show a file in a surface. One surface per file: a file that already has
 * one gets it brought to the front. Resolves with the surface's id, or with
 * null when the canvas it was asked for is no longer the one that is open:
 * then no surface is made. `visit` is the visit of the canvas the request
 * belongs to, when it was started before this call (a layout being put
 * back); otherwise it is the visit that is open now.
 */
export async function openFileSurface(fileId: string, options: { placement?: Placement; rect?: Rect; visit?: number } = {}): Promise<string | null> {
  const { visit = canvasVisit(), ...place_ } = options;
  const left = () => canvasVisit() !== visit;
  if (left()) return null;
  const existing = useSurfaces.getState().surfaces.find((s) => s.fileId === fileId);
  if (existing) {
    if (existing.placement === 'minimized') restoreSurface(existing.surfaceId); else focusSurface(existing.surfaceId);
    return existing.surfaceId;
  }
  const surfaceId = newSurfaceId();
  const record = await reconcileFile(fileId);
  if (left()) return null;
  const name = (record.relativePath ?? '').split('/').pop() || fileId;
  /** The surface, unless someone else opened the same file while this one was getting ready. */
  const place = (documentId: string, more: { reading?: boolean; notice?: Surface['notice'] } = {}): string => {
    const raced = useSurfaces.getState().surfaces.find((s) => s.fileId === fileId);
    if (raced) { void documents.closeView(surfaceId); focusSurface(raced.surfaceId); return raced.surfaceId; }
    const made = openSurface(documentId, surfaceKindOf(name), { surfaceId, fileId, workspaceId: record.workspaceId, title: name, ...place_, ...more });
    if (place_.placement !== 'minimized') focusSurface(made);
    return made;
  };
  // a file that is read, not typed into, has a reader and no document
  if (isReadOnly(name)) return place(`reader:${fileId}`, { reading: true });
  let documentId: string;
  try {
    documentId = (await documents.open(fileId, surfaceId)).documentId;
  } catch (e) {
    if (left()) return null;
    // it cannot be typed into here: the surface opens all the same, and says why
    if (e instanceof WorkspaceError && e.code === 'too-large') return place(`notice:${fileId}`, { notice: 'too-large' });
    if (e instanceof WorkspaceError && (e.code === 'not-text' || e.code === 'not-utf8')) return place(`notice:${fileId}`, { notice: 'not-text' });
    throw e;
  }
  // the canvas was left while the file was being read: the view that was opened for a surface that will not be is closed again
  if (left()) { void documents.closeView(surfaceId); return null; }
  return place(documentId);
}

/**
 * Show a task of the canvas in a surface of its own: the same panel the
 * selected node gets at the side, for this one task, movable like any
 * other surface. One surface per task; a task that has one gets it brought
 * to the front. Several tasks can each have theirs open at once, in the one
 * window. Resolves with the surface's id.
 */
export function openTaskSurface(taskNodeId: string, title: string, options: { placement?: Placement; rect?: Rect } = {}): string {
  const existing = useSurfaces.getState().surfaces.find((s) => s.taskNodeId === taskNodeId);
  if (existing) {
    if (existing.placement === 'minimized') restoreSurface(existing.surfaceId); else focusSurface(existing.surfaceId);
    return existing.surfaceId;
  }
  const { container, surfaces } = useSurfaces.getState();
  // a task panel is tall and narrow; each new one stands beside the last, from the left
  const size = { width: 440, height: Math.max(MIN_SURFACE.height, Math.min(640, container.height - 96)) };
  const others = surfaces.filter((s) => s.kind === 'task').length;
  const rect = options.rect ?? { ...size, x: 72 + (others % 4) * (size.width + 16), y: 56 + (others % 4) * 12 };
  const made = openSurface(`task:${taskNodeId}`, 'task', { taskNodeId, title, placement: options.placement, rect, visit: canvasVisit() });
  focusSurface(made);
  return made;
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

/**
 * Open again what this canvas had open, where it was. A file that is no
 * longer there is left out. It belongs to the visit of the canvas it was
 * started on: if the canvas is left before it is done, it stops, and
 * nothing more of it is opened.
 */
export async function restoreLayout(canvasId: string): Promise<void> {
  const visit = canvasVisit();
  let saved: SavedSurface[] = [];
  try { saved = JSON.parse(localStorage.getItem(layoutKey(canvasId)) ?? '[]'); } catch { /* nothing to put back */ }
  if (!Array.isArray(saved)) return;
  for (const entry of saved) {
    if (canvasVisit() !== visit) return;
    if (!entry || typeof entry.fileId !== 'string' || !entry.rect) continue;
    try {
      const record = await reconcileFile(entry.fileId);
      if (canvasVisit() !== visit) return;
      if (record.status === 'missing' || record.status === 'ambiguous') continue;
      const surfaceId = await openFileSurface(entry.fileId, { placement: entry.placement, rect: entry.rect, visit });
      if (surfaceId === null) return;
      if (entry.back) change(surfaceId, () => ({ back: entry.back }));
    } catch { /* the file, or its workspace, is not there any more */ }
  }
}

/** Close every surface: the canvas is being left. Their documents are saved or kept as drafts by the document service. */
export function closeAllSurfaces(): void {
  for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId, { leaving: true });
}
