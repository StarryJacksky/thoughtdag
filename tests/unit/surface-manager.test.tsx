import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import SurfaceManager from '../../src/components/surfaces/SurfaceManager';
import { documents } from '../../src/lib/documents/document-service';
import { MIN_SURFACE, TITLE_BAR_HEIGHT, closeSurface, fitRect, focusSurface, openFileSurface, openSurface, restoreLayout, restoreSurface, saveLayout, setContainer, setPlacement, shownRect, updateRect, useSurfaces } from '../../src/lib/documents/surface-store';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, keyHeardByWindow, mount, pointer, type Mounted } from '../helpers/render';

// Surfaces: the movable, non-modal frames a document is shown in. What is
// checked is where a frame may be, what maximizing, minimizing and docking
// do and undo, that a frame can always be caught again, and that having
// surfaces open takes nothing away from the canvas underneath.

let shell: FakeWorkspace;
const CONTAINER = { width: 1200, height: 800 };
const surface = (id: string) => useSurfaces.getState().surfaces.find((s) => s.surfaceId === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;

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
    const id = await openFileSurface(fileIdOf('notes/a.md'));
    const state = surface(id);
    expect(Object.keys(state).sort()).toEqual(['back', 'documentId', 'fileId', 'kind', 'placement', 'rect', 'surfaceId', 'title'].sort());
    expect(JSON.stringify(useSurfaces.getState())).not.toContain('content of a.md');
    expect(documents.get(state.documentId)!.text).toBe('content of a.md\n');
  });

  it('is one surface per file: opening the file again brings its surface to the front', async () => {
    const first = await openFileSurface(fileIdOf('notes/a.md'));
    const other = await openFileSurface(fileIdOf('notes/b.tex'));
    expect(await openFileSurface(fileIdOf('notes/a.md'))).toBe(first);
    expect(useSurfaces.getState().order).toEqual([other, first]);
    expect(useSurfaces.getState().surfaces.length).toBe(2);
  });

  it('picks the kind of surface from the kind of file', async () => {
    expect(surface(await openFileSurface(fileIdOf('notes/a.md'))).kind).toBe('markdown');
    expect(surface(await openFileSurface(fileIdOf('notes/b.tex'))).kind).toBe('text');
  });
});

describe('surfaces on screen', () => {
  let view: Mounted;
  const frames = () => [...view.container.querySelectorAll<HTMLElement>('[data-surface]')];
  const frameOf = (id: string) => view.container.querySelector<HTMLElement>(`[data-surface="${id}"]`)!;
  const openAll = async () => {
    const ids: string[] = [];
    for (const name of ['a.md', 'b.tex', 'c.py', 'd.txt']) ids.push(await openFileSurface(fileIdOf(`notes/${name}`)));
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
    expect(frames().map((f) => f.querySelector<HTMLTextAreaElement>('[data-surface-text]')!.value)).toEqual(['content of a.md\n', 'content of b.tex\n', 'content of c.py\n', 'content of d.txt\n']);
  });

  it('bring a frame to the front when it is touched, and send typing only to the document that has the focus', async () => {
    let ids: string[] = [];
    await during(async () => { ids = await openAll(); });
    for (const id of [ids[1], ids[3], ids[0], ids[2], ids[1]]) {
      await during(() => pointer(frameOf(id), 'pointerdown', { x: 10, y: 10 }));
      expect(useSurfaces.getState().order.at(-1)).toBe(id);
    }
    const front = frameOf(ids[1]);
    const box = front.querySelector<HTMLTextAreaElement>('[data-surface-text]')!;
    await during(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setValue.call(box, 'content of b.tex\nTYPED_INTO_B_N3\n');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(documents.documentOf(fileIdOf('notes/b.tex'))!.text).toBe('content of b.tex\nTYPED_INTO_B_N3\n');
    for (const other of ['a.md', 'c.py', 'd.txt']) expect(documents.documentOf(fileIdOf(`notes/${other}`))!.text).toBe(`content of ${other}\n`);
  });

  it('keep what is typed in a surface away from the canvas: its delete, undo and letter shortcuts never hear it', async () => {
    let ids: string[] = [];
    await during(async () => { ids = await openAll(); });
    const box = frameOf(ids[0]).querySelector<HTMLTextAreaElement>('[data-surface-text]')!;
    for (const key of [{ key: 'Delete' }, { key: 'Backspace' }, { key: 'z', metaKey: true }, { key: 'z', ctrlKey: true }, { key: 'r' }, { key: ' ' }, { key: 'ArrowUp' }, { key: 'Enter' }, { key: 'Escape' }]) {
      expect(keyHeardByWindow(box, key), JSON.stringify(key)).toBe(false);
    }
    // a key pressed outside any surface is the canvas's to hear
    expect(keyHeardByWindow(document.body, { key: 'Delete' })).toBe(true);
  });

  it('move with their title bar, and hold the pointer only for as long as the drag lasts', async () => {
    let id = '';
    await during(async () => { id = await openFileSurface(fileIdOf('notes/a.md')); });
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
    await during(async () => { id = await openFileSurface(fileIdOf('notes/a.md')); });
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
    await during(async () => { id = await openFileSurface(fileIdOf('notes/a.md')); });
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
    await during(async () => { id = await openFileSurface(fileIdOf('notes/a.md')); });
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
    const a = await openFileSurface(fileIdOf('notes/a.md'));
    const b = await openFileSurface(fileIdOf('notes/b.tex'));
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
    await openFileSurface(fileIdOf('notes/a.md'));
    await openFileSurface(fileIdOf('notes/b.tex'));
    saveLayout('canvas-1');
    expect(localStorage.getItem('thoughtdag.surfaces.canvas-1')).not.toContain('content of');
    for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
    await documents.dispose();
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'missing';
    await restoreLayout('canvas-1');
    expect(useSurfaces.getState().surfaces.map((s) => s.title)).toEqual(['b.tex']);
  });

  it('belongs to its canvas: another canvas has its own, or none', async () => {
    await openFileSurface(fileIdOf('notes/a.md'));
    saveLayout('canvas-1');
    for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
    await documents.dispose();
    await restoreLayout('canvas-2');
    expect(useSurfaces.getState().surfaces).toEqual([]);
  });
});
