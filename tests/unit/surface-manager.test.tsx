import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import SurfaceManager from '../../src/components/surfaces/SurfaceManager';
import { documents } from '../../src/lib/documents/document-service';
import { MIN_SURFACE, TITLE_BAR_HEIGHT, closeSurface, fitRect, focusSurface, openFileSurface, openSurface, restoreLayout, restoreSurface, saveLayout, setContainer, setPlacement, shownRect, updateRect, useSurfaces } from '../../src/lib/documents/surface-store';
import { closeAllSurfaces, openTaskSurface } from '../../src/lib/documents/surface-store';
import WorkspaceExplorer from '../../src/components/workspace/WorkspaceExplorer';
import WorkspaceLayer from '../../src/components/workspace/WorkspaceLayer';
import { createInGraph } from '../../src/components/workspace/actions';
import { useWorkspacePanel } from '../../src/lib/workspace/session';
import { useStore } from '../../src/store';
import type { ThoughtNode } from '../../src/types';
import { useUiStore } from '../../src/lib/ui-store';
import { useProjects } from '../../src/store/projects';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, keyHeardByWindow, mount, pointer, withoutLayout, type Mounted } from '../helpers/render';

// Surfaces: the movable, non-modal frames a document is shown in. What is
// checked is where a frame may be, what maximizing, minimizing and docking
// do and undo, that a frame can always be caught again, and that having
// surfaces open takes nothing away from the canvas underneath.

/** Open a file in a surface on the canvas that is open, and its surface's id. */
const opened = async (...args: Parameters<typeof openFileSurface>): Promise<string> => {
  const id = await openFileSurface(...args);
  if (id === null) throw new Error('the canvas was left while the file was opening');
  return id;
};

let shell: FakeWorkspace;
const CONTAINER = { width: 1200, height: 800 };
const surface = (id: string) => useSurfaces.getState().surfaces.find((s) => s.surfaceId === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;

/** The editor a frame shows, and what it holds. */
const editorOf = (frame: ParentNode) => EditorView.findFromDOM(frame.querySelector<HTMLElement>('.cm-editor')!)!;
const textIn = (frame: ParentNode) => editorOf(frame).state.doc.toString();

beforeAll(() => withoutLayout());
beforeEach(() => {
  shell = installFakeWorkspace();
  for (const name of ['a.md', 'b.tex', 'c.py', 'd.txt']) shell.seed(`notes/${name}`, `content of ${name}\n`);
  useSurfaces.setState({ surfaces: [], order: [], container: CONTAINER });
  localStorage.clear();
});
afterEach(async () => {
  for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
  await documents.dispose();
  shell.uninstall();
});

describe('where a surface may be', () => {
  it('is never smaller than 360 by 240, however it is resized', () => {
    expect(MIN_SURFACE).toEqual({ width: 360, height: 240 });
    const id = openSurface('doc_1', 'text');
    updateRect(id, { x: 100, y: 100, width: 10, height: 10 });
    expect(surface(id).rect).toMatchObject({ width: 360, height: 240 });
    updateRect(id, { x: 100, y: 100, width: 359, height: 500 });
    expect(surface(id).rect).toMatchObject({ width: 360, height: 500 });
  });

  it('keeps its title bar where it can be caught: dragged out of the container, it comes back to the edge', () => {
    const id = openSurface('doc_1', 'text');
    updateRect(id, { x: 5000, y: 5000, width: 500, height: 400 });
    let r = surface(id).rect;
    expect(r.y).toBeLessThanOrEqual(CONTAINER.height - TITLE_BAR_HEIGHT);
    expect(r.x).toBeLessThan(CONTAINER.width);
    expect(CONTAINER.width - r.x, 'enough of the title bar is inside to take hold of').toBeGreaterThanOrEqual(96);

    updateRect(id, { x: -5000, y: -5000, width: 500, height: 400 });
    r = surface(id).rect;
    expect(r.y, 'the title bar is never above the top').toBe(0);
    expect(r.x + r.width).toBeGreaterThanOrEqual(96);
  });

  it('is brought back inside when the container gets smaller around it', () => {
    const id = openSurface('doc_1', 'text');
    updateRect(id, { x: 700, y: 500, width: 480, height: 280 });
    setContainer({ width: 600, height: 400 });
    const r = surface(id).rect;
    expect(r.y).toBeLessThanOrEqual(400 - TITLE_BAR_HEIGHT);
    expect(600 - r.x).toBeGreaterThanOrEqual(96);
    expect(r.width).toBeLessThanOrEqual(600);
    expect(fitRect(r, { width: 600, height: 400 })).toEqual(r);
  });

  it('opens new surfaces beside each other, not exactly on top of one another', () => {
    const ids = ['doc_1', 'doc_2', 'doc_3'].map((d) => openSurface(d, 'text'));
    const spots = ids.map((id) => `${surface(id).rect.x},${surface(id).rect.y}`);
    expect(new Set(spots).size).toBe(3);
  });
});

describe('maximizing, minimizing and docking', () => {
  it('fills the container when maximized, and goes back to exactly where it was', () => {
    const id = openSurface('doc_1', 'text');
    updateRect(id, { x: 200, y: 120, width: 500, height: 400 });
    setPlacement(id, 'maximized');
    expect(shownRect(surface(id), CONTAINER)).toEqual({ x: 0, y: 0, ...CONTAINER });
    restoreSurface(id);
    expect(surface(id)).toMatchObject({ placement: 'floating', rect: { x: 200, y: 120, width: 500, height: 400 } });
  });

  it('is out of the way when minimized, still open, and comes back as it was', () => {
    const id = openSurface('doc_1', 'text');
    setPlacement(id, 'left');
    setPlacement(id, 'minimized');
    expect(shownRect(surface(id), CONTAINER)).toBeNull();
    expect(useSurfaces.getState().surfaces.length).toBe(1);
    restoreSurface(id);
    expect(surface(id).placement).toBe('left');
  });

  it('takes one side of the container at full height when docked, and never more than half of it', () => {
    const id = openSurface('doc_1', 'text');
    updateRect(id, { x: 300, y: 200, width: 900, height: 300 });
    setPlacement(id, 'left');
    expect(shownRect(surface(id), CONTAINER)).toEqual({ x: 0, y: 0, width: 600, height: 800 });
    setPlacement(id, 'right');
    expect(shownRect(surface(id), CONTAINER)).toEqual({ x: 600, y: 0, width: 600, height: 800 });
    restoreSurface(id);
    expect(surface(id)).toMatchObject({ placement: 'floating', rect: { x: 300, y: 200, width: 900, height: 300 } });
  });

  it('remembers one place to go back to: maximizing a docked surface and restoring it returns to the dock', () => {
    const id = openSurface('doc_1', 'text');
    setPlacement(id, 'right');
    setPlacement(id, 'maximized');
    restoreSurface(id);
    expect(surface(id).placement).toBe('right');
  });
});

describe('which surface is in front', () => {
  it('is the one opened or touched last', () => {
    const [a, b, c] = ['doc_1', 'doc_2', 'doc_3'].map((d) => openSurface(d, 'text'));
    expect(useSurfaces.getState().order).toEqual([a, b, c]);
    focusSurface(a);
    expect(useSurfaces.getState().order).toEqual([b, c, a]);
    closeSurface(a);
    expect(useSurfaces.getState().order).toEqual([b, c]);
  });
});

describe('a surface holds no text', () => {
  it('knows which document it shows and where it sits, and nothing of what the document says', async () => {
    const id = await opened(fileIdOf('notes/a.md'));
    const state = surface(id);
    expect(Object.keys(state).sort()).toEqual(['back', 'documentId', 'fileId', 'kind', 'notice', 'placement', 'reading', 'rect', 'surfaceId', 'taskNodeId', 'title', 'visit', 'workspaceId'].sort());
    expect(JSON.stringify(useSurfaces.getState())).not.toContain('content of a.md');
    expect(documents.get(state.documentId)!.text).toBe('content of a.md\n');
  });

  it('is one surface per file: opening the file again brings its surface to the front', async () => {
    const first = await opened(fileIdOf('notes/a.md'));
    const other = await opened(fileIdOf('notes/b.tex'));
    expect(await opened(fileIdOf('notes/a.md'))).toBe(first);
    expect(useSurfaces.getState().order).toEqual([other, first]);
    expect(useSurfaces.getState().surfaces.length).toBe(2);
  });

  it('picks the kind of surface from the kind of file', async () => {
    expect(surface(await opened(fileIdOf('notes/a.md'))).kind).toBe('markdown');
    expect(surface(await opened(fileIdOf('notes/b.tex'))).kind).toBe('text');
  });
});

describe('surfaces on screen', () => {
  let view: Mounted;
  const frames = () => [...view.container.querySelectorAll<HTMLElement>('[data-surface]')];
  const frameOf = (id: string) => view.container.querySelector<HTMLElement>(`[data-surface="${id}"]`)!;
  const openAll = async () => {
    const ids: string[] = [];
    for (const name of ['a.md', 'b.tex', 'c.py', 'd.txt']) ids.push(await opened(fileIdOf(`notes/${name}`)));
    return ids;
  };

  beforeEach(async () => { view = await mount(<SurfaceManager />); });
  afterEach(async () => { await view.unmount(); });

  it('put no layer over the canvas: only the frames themselves take the pointer', async () => {
    await during(async () => { await openAll(); });
    const layer = view.container.querySelector<HTMLElement>('[data-surface-layer]')!;
    expect(layer.style.pointerEvents).toBe('none');
    for (const frame of frames()) expect(frame.style.pointerEvents).toBe('auto');
    // nothing that covers the whole app and swallows clicks
    expect(view.container.querySelector('.fixed.inset-0')).toBeNull();
  });

  it('show four documents at once, each in its own frame with its own text', async () => {
    await during(async () => { await openAll(); });
    expect(frames().length).toBe(4);
    expect(frames().map(textIn)).toEqual(['content of a.md\n', 'content of b.tex\n', 'content of c.py\n', 'content of d.txt\n']);
  });

  it('bring a frame to the front when it is touched, and send typing only to the document that has the focus', async () => {
    let ids: string[] = [];
    await during(async () => { ids = await openAll(); });
    for (const id of [ids[1], ids[3], ids[0], ids[2], ids[1]]) {
      await during(() => pointer(frameOf(id), 'pointerdown', { x: 10, y: 10 }));
      expect(useSurfaces.getState().order.at(-1)).toBe(id);
    }
    const front = editorOf(frameOf(ids[1]));
    await during(() => front.dispatch({ changes: { from: front.state.doc.length, insert: 'TYPED_INTO_B_N3\n' }, userEvent: 'input.type' }));
    expect(documents.documentOf(fileIdOf('notes/b.tex'))!.text).toBe('content of b.tex\nTYPED_INTO_B_N3\n');
    for (const other of ['a.md', 'c.py', 'd.txt']) expect(documents.documentOf(fileIdOf(`notes/${other}`))!.text).toBe(`content of ${other}\n`);
  });

  it('keep what is typed in a surface away from the canvas: its delete, undo and letter shortcuts never hear it', async () => {
    let ids: string[] = [];
    await during(async () => { ids = await openAll(); });
    const box = editorOf(frameOf(ids[0])).contentDOM;
    for (const key of [{ key: 'Delete' }, { key: 'Backspace' }, { key: 'z', metaKey: true }, { key: 'z', ctrlKey: true }, { key: 'r' }, { key: ' ' }, { key: 'ArrowUp' }, { key: 'Enter' }, { key: 'Escape' }]) {
      expect(keyHeardByWindow(box, key), JSON.stringify(key)).toBe(false);
    }
    // a key pressed outside any surface is the canvas's to hear
    expect(keyHeardByWindow(document.body, { key: 'Delete' })).toBe(true);
  });

  it('move with their title bar, and hold the pointer only for as long as the drag lasts', async () => {
    let id = '';
    await during(async () => { id = await opened(fileIdOf('notes/a.md')); });
    await during(() => updateRect(id, { x: 100, y: 100, width: 500, height: 400 }));
    const bar = frameOf(id).querySelector<HTMLElement>('[data-surface-titlebar]')!;
    const held: string[] = [];
    bar.setPointerCapture = () => { held.push('capture'); };
    bar.releasePointerCapture = () => { held.push('release'); };
    await during(() => pointer(bar, 'pointerdown', { x: 300, y: 110 }));
    expect(held).toEqual(['capture']);
    await during(() => pointer(bar, 'pointermove', { x: 420, y: 190 }));
    expect(surface(id).rect).toMatchObject({ x: 220, y: 180, width: 500, height: 400 });
    await during(() => pointer(bar, 'pointerup', { x: 420, y: 190 }));
    expect(held).toEqual(['capture', 'release']);
    // the pointer moving afterwards moves nothing
    await during(() => pointer(bar, 'pointermove', { x: 900, y: 600 }));
    expect(surface(id).rect).toMatchObject({ x: 220, y: 180 });
  });

  it('are resized from the corner, down to the smallest size and no further', async () => {
    let id = '';
    await during(async () => { id = await opened(fileIdOf('notes/a.md')); });
    await during(() => updateRect(id, { x: 100, y: 100, width: 500, height: 400 }));
    const grip = frameOf(id).querySelector<HTMLElement>('[data-surface-resize]')!;
    grip.setPointerCapture = () => {};
    grip.releasePointerCapture = () => {};
    await during(() => pointer(grip, 'pointerdown', { x: 600, y: 500 }));
    await during(() => pointer(grip, 'pointermove', { x: 700, y: 560 }));
    expect(surface(id).rect).toMatchObject({ x: 100, y: 100, width: 600, height: 460 });
    await during(() => pointer(grip, 'pointermove', { x: 110, y: 110 }));
    expect(surface(id).rect).toMatchObject({ x: 100, y: 100, width: 360, height: 240 });
    await during(() => pointer(grip, 'pointerup', { x: 110, y: 110 }));
  });

  it('are put away in the tray when minimized, and come back from it', async () => {
    let id = '';
    await during(async () => { id = await opened(fileIdOf('notes/a.md')); });
    await during(() => frameOf(id).querySelector<HTMLElement>('[data-surface-minimize]')!.click());
    expect(frames().length).toBe(0);
    const chip = view.container.querySelector<HTMLElement>(`[data-surface-chip="${id}"]`)!;
    expect(chip.textContent).toContain('a.md');
    await during(() => chip.click());
    expect(frames().length).toBe(1);
    expect(surface(id).placement).toBe('floating');
  });

  it('close without touching the file: the view goes, the file and what it holds stay', async () => {
    let id = '';
    await during(async () => { id = await opened(fileIdOf('notes/a.md')); });
    await during(() => frameOf(id).querySelector<HTMLElement>('[data-surface-close]')!.click());
    expect(frames().length).toBe(0);
    expect(useSurfaces.getState().surfaces).toEqual([]);
    await during(async () => { await Promise.resolve(); });
    expect(documents.documentOf(fileIdOf('notes/a.md'))).toBeUndefined();
    expect(shell.calls.filter((c) => ['trashFile', 'trashFolder', 'moveFile'].includes(c.method))).toEqual([]);
    expect(shell.files.get(fileIdOf('notes/a.md'))).toMatchObject({ status: 'ready', content: 'content of a.md\n' });
  });
});

describe('the layout of a canvas\'s surfaces', () => {
  it('is put back when the canvas is opened again: the same files, where and how they were', async () => {
    const a = await opened(fileIdOf('notes/a.md'));
    const b = await opened(fileIdOf('notes/b.tex'));
    updateRect(a, { x: 140, y: 90, width: 520, height: 380 });
    setPlacement(b, 'right');
    saveLayout('canvas-1');
    for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
    await documents.dispose();

    await restoreLayout('canvas-1');
    const back = useSurfaces.getState().surfaces;
    expect(back.map((s) => [s.title, s.placement])).toEqual([['a.md', 'floating'], ['b.tex', 'right']]);
    expect(back[0].rect).toEqual({ x: 140, y: 90, width: 520, height: 380 });
    expect(back.map((s) => s.surfaceId)).not.toContain(a);
  });

  it('leaves out a file that is no longer there, and says nothing of the text of any file', async () => {
    await opened(fileIdOf('notes/a.md'));
    await opened(fileIdOf('notes/b.tex'));
    saveLayout('canvas-1');
    expect(localStorage.getItem('thoughtdag.surfaces.canvas-1')).not.toContain('content of');
    for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
    await documents.dispose();
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'missing';
    await restoreLayout('canvas-1');
    expect(useSurfaces.getState().surfaces.map((s) => s.title)).toEqual(['b.tex']);
  });

  it('belongs to its canvas: another canvas has its own, or none', async () => {
    await opened(fileIdOf('notes/a.md'));
    saveLayout('canvas-1');
    for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
    await documents.dispose();
    await restoreLayout('canvas-2');
    expect(useSurfaces.getState().surfaces).toEqual([]);
  });
});

// ── what the second review found (its R2 numbers) ──────────────────────

describe('the surface in front is the one that is typed into', () => {
  let view: Mounted;
  const frameOf = (id: string) => view.container.querySelector<HTMLElement>(`[data-surface="${id}"]`)!;
  const textOf = (name: string) => documents.documentOf(fileIdOf(`notes/${name}`))!.text;
  /** A press and release on a frame's title bar, away from its buttons: what brings it forward without touching its text. */
  const pressTitleBar = async (id: string) => {
    const bar = frameOf(id).querySelector<HTMLElement>('[data-surface-titlebar]')!;
    bar.setPointerCapture = () => {};
    bar.releasePointerCapture = () => {};
    await during(() => pointer(bar, 'pointerdown', { x: 12, y: 12 }));
    await during(() => pointer(bar, 'pointerup', { x: 12, y: 12 }));
  };
  /** A key pressed wherever the focus is. */
  const pressKey = (init: KeyboardEventInit) => during(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  const openTwo = async () => {
    let a = '';
    let b = '';
    await during(async () => { a = await opened(fileIdOf('notes/a.md')); b = await opened(fileIdOf('notes/b.tex')); });
    // the person types into B
    await during(() => { editorOf(frameOf(b)).focus(); });
    expect(frameOf(b).contains(document.activeElement)).toBe(true);
    return { a, b };
  };

  beforeEach(async () => { view = await mount(<SurfaceManager />); });
  afterEach(async () => { await view.unmount(); });

  it('[R2-15] a surface brought forward by its title bar takes the keys that follow; the one typed into before gets none of them', async () => {
    const { a, b } = await openTwo();
    await pressTitleBar(a);
    expect(useSurfaces.getState().order.at(-1)).toBe(a);
    expect(frameOf(a).contains(document.activeElement), 'the focus is in the surface in front').toBe(true);
    expect(frameOf(b).contains(document.activeElement)).toBe(false);
    await pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(textOf('b.tex'), 'the document behind is not typed into').toBe('content of b.tex\n');
    expect(textOf('a.md')).not.toBe('content of a.md\n');
    // and undo is the front document's undo
    await pressKey({ key: 'z', ctrlKey: true });
    expect(textOf('a.md')).toBe('content of a.md\n');
    expect(textOf('b.tex')).toBe('content of b.tex\n');
  });

  it('[R2-15] a surface keeps its own cursor while another is in front', async () => {
    const { a, b } = await openTwo();
    await during(() => { editorOf(frameOf(b)).dispatch({ selection: { anchor: 8 } }); });
    await pressTitleBar(a);
    await pressTitleBar(b);
    expect(frameOf(b).contains(document.activeElement)).toBe(true);
    expect(editorOf(frameOf(b)).state.selection.main.head).toBe(8);
  });

  it('[R2-15] a surface dragged by its title bar is the one typed into when the drag ends', async () => {
    const { a, b } = await openTwo();
    const bar = frameOf(a).querySelector<HTMLElement>('[data-surface-titlebar]')!;
    bar.setPointerCapture = () => {};
    bar.releasePointerCapture = () => {};
    await during(() => pointer(bar, 'pointerdown', { x: 12, y: 12 }));
    await during(() => pointer(bar, 'pointermove', { x: 80, y: 60 }));
    await during(() => pointer(bar, 'pointerup', { x: 80, y: 60 }));
    expect(frameOf(a).contains(document.activeElement)).toBe(true);
    expect(frameOf(b).contains(document.activeElement)).toBe(false);
  });

  it('[R2-15] a surface brought back from the tray is the one typed into', async () => {
    const { a, b } = await openTwo();
    await during(() => setPlacement(a, 'minimized'));
    await during(() => { editorOf(frameOf(b)).focus(); });
    await during(() => view.container.querySelector<HTMLElement>(`[data-surface-chip="${a}"]`)!.click());
    expect(frameOf(a).contains(document.activeElement)).toBe(true);
    await pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(textOf('b.tex')).toBe('content of b.tex\n');
  });

  it('a surface just opened is typed into at once: the focus is in its editor, not only in its frame', async () => {
    let a = '';
    await during(async () => { a = await opened(fileIdOf('notes/a.md')); });
    expect(document.activeElement, 'the editor, made after the frame took the focus, has it').toBe(editorOf(frameOf(a)).contentDOM);
    await pressKey({ key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(textOf('a.md')).not.toBe('content of a.md\n');
  });

  it('the surface in front when a canvas\'s surfaces are put back is typed into at once', async () => {
    await during(async () => { await opened(fileIdOf('notes/a.md')); await opened(fileIdOf('notes/b.tex')); });
    saveLayout('canvas-1');
    await during(async () => { for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId); await documents.dispose(); });
    document.body.focus();
    await during(async () => { await restoreLayout('canvas-1'); });
    const front = useSurfaces.getState().order.at(-1)!;
    expect(useSurfaces.getState().surfaces.find((s) => s.surfaceId === front)!.title).toBe('b.tex');
    expect(document.activeElement).toBe(editorOf(frameOf(front)).contentDOM);
  });

  it('an editor made while the focus is somewhere else in its frame leaves it there: a note switched back from reading to writing keeps it on the switch', async () => {
    let a = '';
    await during(async () => { a = await opened(fileIdOf('notes/a.md')); });
    const tab = (mode: string) => frameOf(a).querySelector<HTMLElement>(`[data-markdown-mode="${mode}"]`)!;
    await during(() => { tab('reading').focus(); tab('reading').click(); });
    expect(frameOf(a).querySelector('.cm-content')).toBeNull();
    await during(() => { tab('live').focus(); tab('live').click(); });
    expect(frameOf(a).querySelector('.cm-content'), 'the editor is made anew').not.toBeNull();
    expect(document.activeElement).toBe(tab('live'));
  });

  it('[R2-15] a surface with nothing to type into still takes the focus from the one behind it', async () => {
    shell.seed('notes/big.txt', '');
    shell.files.get(fileIdOf('notes/big.txt'))!.bytes = new Uint8Array(8 * 1024 * 1024 + 1);
    const { b } = await openTwo();
    let notice = '';
    await during(async () => { notice = await opened(fileIdOf('notes/big.txt')); });
    await during(() => { editorOf(frameOf(b)).focus(); });
    await pressTitleBar(notice);
    expect(frameOf(b).contains(document.activeElement), 'keys no longer go to the document behind').toBe(false);
    expect(frameOf(notice).contains(document.activeElement)).toBe(true);
  });
});

describe('a canvas that is left while a file is still opening', () => {
  const twoCanvases = () => useProjects.setState({ projects: [{ id: 'canvas-A', name: 'A', createdAt: 0, updatedAt: 0 }, { id: 'canvas-B', name: 'B', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-A', switching: false });
  /** What leaving a canvas for another does to the surfaces (see useWorkspaceSync). */
  const switchTo = (id: string) => {
    useProjects.setState({ switching: true });
    closeAllSurfaces();
    useProjects.setState({ activeId: id, switching: false });
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 10));
  afterEach(() => useProjects.setState({ projects: [], activeId: null, switching: false }));

  for (const step of ['reconcile', 'readText'] as const) {
    it(`[R2-16] a file whose ${step === 'reconcile' ? 'record' : 'text'} arrives after the canvas was left opens no surface on the canvas that is there now`, async () => {
      twoCanvases();
      const slow = shell.holdNext(step);
      const opening = openFileSurface(fileIdOf('notes/a.md'));
      await settled();
      switchTo('canvas-B');
      slow.release();
      await opening;
      await settled();
      expect(useSurfaces.getState().surfaces.map((s) => s.title), 'canvas B shows nothing of canvas A').toEqual([]);
      saveLayout('canvas-B');
      expect(localStorage.getItem('thoughtdag.surfaces.canvas-B')).toBeNull();
      expect(documents.documentOf(fileIdOf('notes/a.md')), 'the document it opened for a view that never came is let go').toBeUndefined();
    });
  }

  it('[R2-16] a layout that is still being put back when the canvas is left puts nothing on the next canvas, and is whole when its own canvas is opened again', async () => {
    twoCanvases();
    await opened(fileIdOf('notes/a.md'));
    await opened(fileIdOf('notes/b.tex'));
    saveLayout('canvas-A');
    const saved = localStorage.getItem('thoughtdag.surfaces.canvas-A');
    switchTo('canvas-B');
    await settled();
    switchTo('canvas-A');

    const slow = shell.holdNext('reconcile');
    const restoring = restoreLayout('canvas-A');
    await settled();
    switchTo('canvas-B');
    slow.release();
    await restoring;
    await settled();
    expect(useSurfaces.getState().surfaces.map((s) => s.title)).toEqual([]);
    saveLayout('canvas-B');
    expect(localStorage.getItem('thoughtdag.surfaces.canvas-B')).toBeNull();
    expect(localStorage.getItem('thoughtdag.surfaces.canvas-A'), 'canvas A still remembers its own').toBe(saved);

    // back on A: its layout is put back once, whole
    switchTo('canvas-A');
    await restoreLayout('canvas-A');
    expect(useSurfaces.getState().surfaces.map((s) => s.title)).toEqual(['a.md', 'b.tex']);
  });
});

describe('a surface whose document could not be put anywhere when it was closed', () => {
  const refused = (channel: string) => async () => { throw new Error(`Error invoking remote method 'workspace:${channel}': Error: failed: no space left on the disk`); };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 10));
  const typeInto = (name: string, text: string) => {
    const doc = documents.documentOf(fileIdOf(`notes/${name}`))!;
    documents.applyEdit(doc.documentId, { baseBufferRevision: doc.bufferRevision, changes: [{ from: doc.text.length, to: doc.text.length, insert: text }], originSurfaceId: 'someone' });
  };
  let working: Pick<NonNullable<typeof window.desktopWorkspace>, 'saveText' | 'putDraft'>;
  beforeEach(() => {
    useUiStore.setState({ toasts: [] });
    working = { saveText: window.desktopWorkspace!.saveText, putDraft: window.desktopWorkspace!.putDraft };
  });
  afterEach(() => {
    // the disk takes writes again: what was kept open is put away when the test's documents are let go
    Object.assign(window.desktopWorkspace!, working);
    useProjects.setState({ projects: [], activeId: null, switching: false });
  });

  it('[R2-03] comes back with what was typed, and the person is told why', async () => {
    const id = await opened(fileIdOf('notes/a.md'));
    updateRect(id, { x: 140, y: 90, width: 520, height: 380 });
    typeInto('a.md', 'UNSAVED_Q7\n');
    window.desktopWorkspace!.saveText = refused('save-text');
    window.desktopWorkspace!.putDraft = refused('put-draft');
    closeSurface(id);
    expect(useSurfaces.getState().surfaces).toEqual([]);
    await settled();
    const back = useSurfaces.getState().surfaces;
    expect(back.map((s) => s.title)).toEqual(['a.md']);
    expect(back[0].rect).toEqual({ x: 140, y: 90, width: 520, height: 380 });
    expect(documents.get(back[0].documentId)?.text).toBe('content of a.md\nUNSAVED_Q7\n');
    expect(useUiStore.getState().toasts.map((toast) => toast.kind)).toEqual(['error']);
    expect(useUiStore.getState().toasts[0].message).toContain('a.md');
  });

  it('[R2-03] is not opened on another canvas when it was closed by leaving its own; the text is kept and the person is told', async () => {
    useProjects.setState({ projects: [{ id: 'canvas-A', name: 'A', createdAt: 0, updatedAt: 0 }, { id: 'canvas-B', name: 'B', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-A', switching: false });
    await opened(fileIdOf('notes/a.md'));
    typeInto('a.md', 'UNSAVED_Q7\n');
    window.desktopWorkspace!.saveText = refused('save-text');
    window.desktopWorkspace!.putDraft = refused('put-draft');
    useProjects.setState({ switching: true });
    closeAllSurfaces();
    useProjects.setState({ activeId: 'canvas-B', switching: false });
    await settled();
    expect(useSurfaces.getState().surfaces).toEqual([]);
    expect(documents.documentOf(fileIdOf('notes/a.md'))?.text).toBe('content of a.md\nUNSAVED_Q7\n');
    expect(useUiStore.getState().toasts.map((toast) => toast.kind)).toEqual(['error']);
  });
});

describe('what a gesture made on one canvas opens, when its waits end on another (third review)', () => {
  const twoCanvases = () => useProjects.setState({ projects: [{ id: 'canvas-A', name: 'A', createdAt: 0, updatedAt: 0 }, { id: 'canvas-B', name: 'B', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-A', switching: false });
  /** What leaving a canvas for another does to the surfaces in the desktop app (see useWorkspaceSync). */
  const switchTo = (id: string) => {
    useProjects.setState({ switching: true });
    closeAllSurfaces();
    useProjects.setState({ activeId: id, switching: false });
  };
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  const nothingOpened = async () => {
    for (let i = 0; i < 6; i++) await during(settled);
    expect(useSurfaces.getState().surfaces.map((s) => s.title), 'nothing of canvas A opens on the canvas that is there now').toEqual([]);
    saveLayout(useProjects.getState().activeId!);
    expect(localStorage.getItem(`thoughtdag.surfaces.${useProjects.getState().activeId}`)).toBeNull();
  };
  let tree: Mounted | null = null;
  const mountTree = async () => {
    useWorkspacePanel.setState({ workspace: shell.workspace, open: true });
    tree = await mount(<WorkspaceExplorer placeAt={() => ({ x: 0, y: 0 })} />);
    for (let i = 0; i < 20 && !tree.container.querySelector('[data-tree-file="top.md"]'); i++) await during(settled);
    return tree;
  };
  beforeEach(() => { shell.seed('top.md', 'FROM_CANVAS_A\n'); });
  afterEach(async () => {
    await tree?.unmount();
    tree = null;
    useWorkspacePanel.setState({ workspace: null, open: false });
    useProjects.setState({ projects: [], activeId: null, switching: false });
  });

  for (const route of [['B'], ['B', 'A']]) {
    const away = route.join('→');
    it(`[R3-09] a file double-clicked in the tree whose identity comes back after A→${away} opens nowhere`, async () => {
      twoCanvases();
      const t = await mountTree();
      const slow = shell.holdNext('registerEntry');
      await during(() => { t.container.querySelector('[data-tree-file="top.md"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
      await during(settled);
      for (const id of route) switchTo(`canvas-${id}`);
      slow.release();
      await nothingOpened();
    });

    it(`[R3-09] a file made from the tree that is made only after A→${away} opens nowhere`, async () => {
      twoCanvases();
      const t = await mountTree();
      await during(() => t.container.querySelector<HTMLElement>('[data-tree-new-file]')!.click());
      const slow = shell.holdNext('createFile');
      await during(() => t.container.querySelector<HTMLElement>('[data-create-file-menu] [data-file-type="md"]')!.click());
      await during(settled);
      for (const id of route) switchTo(`canvas-${id}`);
      slow.release();
      await nothingOpened();
      expect([...shell.files.values()].some((f) => f.relativePath === 'Untitled-001.md'), 'the file itself is made, as asked').toBe(true);
    });

    it(`[R3-09] a file made from the canvas that is made only after A→${away} opens nowhere`, async () => {
      twoCanvases();
      const slow = shell.holdNext('createFile');
      const making = createInGraph('md', { x: 0, y: 0 });
      await during(settled);
      for (const id of route) switchTo(`canvas-${id}`);
      slow.release();
      await making;
      await nothingOpened();
    });
  }

  it('[R3-09] a file opened from the tree with nothing in between opens on the canvas it was opened on', async () => {
    twoCanvases();
    const t = await mountTree();
    await during(() => { t.container.querySelector('[data-tree-file="top.md"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    for (let i = 0; i < 20 && useSurfaces.getState().surfaces.length === 0; i++) await during(settled);
    expect(useSurfaces.getState().surfaces.map((s) => s.title)).toEqual(['top.md']);
  });
});

describe('a task\'s panel outside the desktop app (third review)', () => {
  /** A task of a canvas: copies of a canvas keep the ids of their nodes. */
  const task = (id: string, question: string): ThoughtNode => ({
    id, type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
    data: {
      question, response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 0, highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit', isRoot: false, isBranch: false,
    },
  });
  /** Another canvas is opened as the app does it: the store is swapped while `switching` is set, then the active id changes. Nothing else: what that does to the surfaces is the app's to do. */
  const openCanvas = (id: string, nodes: ThoughtNode[]) => {
    useProjects.setState({ switching: true });
    useStore.setState({ nodes, edges: [] });
    useProjects.setState({ activeId: id, switching: false });
  };
  const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  let app: Mounted | null = null;
  afterEach(async () => {
    await app?.unmount();
    app = null;
    useStore.setState({ nodes: [], edges: [] });
    useProjects.setState({ projects: [], activeId: null, switching: false });
    vi.unstubAllGlobals();
  });

  for (const route of [['B'], ['B', 'A']]) {
    it(`[R3-10] is closed when its canvas is left (A→${route.join('→')}), and never shows a task of the same id on another canvas under its title`, async () => {
      shell.uninstall(); // the web app: no desktop shell, no workspace
      vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
      expect(window.desktopWorkspace).toBeUndefined();
      useProjects.setState({ projects: [{ id: 'canvas-A', name: 'A', createdAt: 0, updatedAt: 0 }, { id: 'canvas-B', name: 'B', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-A', switching: false });
      useStore.setState({ nodes: [task('t-1', 'A_TASK_QUESTION')], edges: [] });
      app = await mount(<><WorkspaceLayer flowPosAt={() => ({ x: 0, y: 0 })} /><SurfaceManager /></>);
      await during(() => { openTaskSurface('t-1', 'A_TASK_TITLE'); });
      expect(app.container.textContent).toContain('A_TASK_QUESTION');

      for (const id of route) {
        await during(() => openCanvas(`canvas-${id}`, [task('t-1', `${id}_TASK_QUESTION`)]));
        await during(settled);
      }
      expect(useSurfaces.getState().surfaces, 'the panel went with its canvas').toEqual([]);
      expect(app.container.textContent).not.toContain('A_TASK_TITLE');
      expect(app.container.textContent).not.toContain('B_TASK_QUESTION');
    });
  }
});
