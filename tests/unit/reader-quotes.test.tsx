import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ResourceReader from '../../src/components/readers/ResourceReader';
import { quoteOnCanvas } from '../../src/components/workspace/actions';
import { validateDTO, type ResourceRef } from '../../src/lib/workspace/contracts';
import { watchWorkspaces } from '../../src/lib/workspace/session';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { docxWith } from '../helpers/synthetic-docx';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, type Mounted } from '../helpers/render';

// What a reader hands on when something in it is quoted, and what it shows
// when its file changes: the things the second review found (its R2
// numbers). A quote must name the place that was selected, all of it, in
// the version that was on screen.
//
// The test DOM draws no PDF. The library and the page are stood in for by
// two plain pages of text, which is all a selection needs; the selection
// itself is a real DOM range.

vi.mock('../../src/lib/pdfjs', () => ({
  loadPdfjs: async () => ({ getDocument: () => ({ promise: Promise.resolve({ numPages: 2, destroy: async () => {} }) }) }),
}));
vi.mock('../../src/components/readers/PdfPage', () => ({
  default: ({ pageNo }: { pageNo: number }) => <div data-page={pageNo}><span data-page-text>{`PAGE_${pageNo}_TEXT_W${pageNo}`}</span></div>,
}));

let shell: FakeWorkspace;
let view: Mounted | null = null;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const whole = (fileId: string): ResourceRef => ({ fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
/** Wait for something to show. What changed is drawn after every step of the wait, so the next look sees it. */
const until = async (ready: () => unknown) => { for (let i = 0; i < 200 && !ready(); i++) await during(tick); };
const seedBytes = (relativePath: string, bytes: Uint8Array) => {
  shell.seed(relativePath, '');
  shell.files.get(fileIdOf(relativePath))!.bytes = bytes;
  return fileIdOf(relativePath);
};
/** Select from one place in the page to another, as a drag would, in either direction. */
const select = (from: [Node, number], to: [Node, number]) => {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.setBaseAndExtent(from[0], from[1], to[0], to[1]);
};
const quoted: { ref: ResourceRef; words: string }[] = [];
const pressQuote = () => during(() => view!.container.querySelector<HTMLElement>('[data-reader-quote]')!.click());

beforeAll(() => bootProjects());
beforeEach(() => {
  shell = installFakeWorkspace();
  quoted.length = 0;
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-1', switching: false });
});
afterEach(async () => {
  window.getSelection()?.removeAllRanges();
  await view?.unmount();
  view = null;
  shell.uninstall();
});

const readerOf = async (relativePath: string) => {
  view = await mount(<div><ResourceReader resourceRef={whole(fileIdOf(relativePath))} name={relativePath.split('/').pop()!} onQuote={(ref, words) => quoted.push({ ref, words })} /></div>);
  await until(() => !view!.container.querySelector('[data-reader-loading]'));
};

describe('a quote put on the canvas', () => {
  it('[R2-18] still says where it is from after it was undone and redone, and after something else was undone', () => {
    const ref: ResourceRef = { fileId: 'file_1', selector: { kind: 'text', quote: 'drop the tails', prefix: 'A robust estimate: ', suffix: '.', baseRevision: fakeRevision('paper'), lines: [3, 3] }, version: { kind: 'live' }, payload: 'text' };
    const id = quoteOnCanvas(ref, 'drop the tails', 'paper.md', { x: 100, y: 100 })!;
    const note = () => useStore.getState().nodes.find((n) => n.id === id);
    expect(note()!.data.quoteRef).toEqual(ref);

    useStore.getState().undo();
    expect(note()).toBeUndefined();
    useStore.getState().redo();
    expect(note()!.data.question).toContain('> drop the tails');
    expect(note()!.data.quoteRef, 'the note that came back still knows what it quotes').toEqual(ref);

    // the note is moved, and the move is taken back
    useStore.setState((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, position: { x: 500, y: 500 } } : n)) }));
    useStore.getState().pushHistory();
    useStore.getState().undo();
    expect(note()!.data.quoteRef).toEqual(ref);
  });
});

describe('a passage quoted from a Word document', () => {
  const body = ['First context SAME after one', 'between', 'Second context SAME after two'];
  const open = async (paragraphs = body) => {
    seedBytes('notes/draft.docx', docxWith(paragraphs));
    await readerOf('notes/draft.docx');
    const text = view!.container.querySelector<HTMLElement>('[data-reader-text]')!.firstChild as Text;
    return { text, shown: text.data };
  };

  it('[R2-19] names the place that was selected when the same words stand earlier in the text too', async () => {
    const { text, shown } = await open();
    const second = shown.lastIndexOf('SAME');
    expect(second).toBeGreaterThan(shown.indexOf('SAME'));
    select([text, second], [text, second + 4]);
    await pressQuote();
    expect(quoted.length).toBe(1);
    const { ref, words } = quoted[0];
    expect(words).toBe('SAME');
    if (ref.selector.kind !== 'text') throw new Error('not a text quote');
    expect(ref.selector.prefix.endsWith('Second context '), ref.selector.prefix).toBe(true);
    expect(ref.selector.suffix.startsWith(' after two')).toBe(true);
    const line = shown.slice(0, second).split('\n').length;
    expect(ref.selector.lines).toEqual([line, line]);
    expect(validateDTO('ResourceRef', ref).ok).toBe(true);
  });

  it('[R2-19] names the same place when the selection was dragged backwards', async () => {
    const { text, shown } = await open();
    const second = shown.lastIndexOf('SAME');
    select([text, second + 4], [text, second]);
    await pressQuote();
    const { ref } = quoted[0];
    if (ref.selector.kind !== 'text') throw new Error('not a text quote');
    expect(ref.selector.prefix.endsWith('Second context ')).toBe(true);
  });

  it('[R2-19] tells one of two identical paragraphs from the other', async () => {
    const { text, shown } = await open(['SAME LINE', 'SAME LINE']);
    const second = shown.lastIndexOf('SAME LINE');
    select([text, second], [text, second + 9]);
    await pressQuote();
    const { ref } = quoted[0];
    if (ref.selector.kind !== 'text') throw new Error('not a text quote');
    const line = shown.slice(0, second).split('\n').length;
    expect(line).toBeGreaterThan(1);
    expect(ref.selector.lines).toEqual([line, line]);
    expect(ref.selector.prefix).toContain('SAME LINE');
  });
});

describe('a passage quoted from a PDF', () => {
  const open = async () => {
    seedBytes('papers/p.pdf', new TextEncoder().encode('%PDF-1.4 synthetic'));
    await readerOf('papers/p.pdf');
    const pages = [...view!.container.querySelectorAll<HTMLElement>('[data-page-text]')].map((el) => el.firstChild as Text);
    expect(pages.length).toBe(2);
    return pages;
  };

  it('[R2-20] names every page the selection runs over, whichever way it was dragged', async () => {
    const [one, two] = await open();
    select([one, 2], [two, 6]);
    await pressQuote();
    select([two, 6], [one, 2]);
    await pressQuote();
    expect(quoted.length).toBe(2);
    for (const { ref, words } of quoted) {
      expect(ref.selector).toMatchObject({ kind: 'pdf', pages: [1, 2] });
      expect(words).toContain('GE_1_TEXT_W1');
      expect(words).toContain('PAGE_2');
      expect(validateDTO('ResourceRef', ref).ok).toBe(true);
    }
  });

  it('[R2-20] names one page for a selection on one page', async () => {
    const [, two] = await open();
    select([two, 0], [two, 6]);
    await pressQuote();
    expect(quoted[0].ref.selector).toMatchObject({ kind: 'pdf', pages: [2] });
  });

  it('[R2-20] quotes nothing when the selection runs out of the reader', async () => {
    const [one] = await open();
    const outside = document.createElement('p');
    outside.textContent = 'NOT_OF_THIS_FILE';
    document.body.appendChild(outside);
    select([one, 2], [outside.firstChild!, 5]);
    await pressQuote();
    select([outside.firstChild!, 5], [one, 2]);
    await pressQuote();
    outside.remove();
    expect(quoted).toEqual([]);
  });

  it('[R2-21] says which version of the file the pages were quoted from', async () => {
    const [one] = await open();
    select([one, 0], [one, 6]);
    await pressQuote();
    const read = shell.calls.filter((c) => c.method === 'readView').length;
    expect(read).toBe(1);
    expect(quoted[0].ref.selector).toMatchObject({ kind: 'pdf', pages: [1], baseRevision: shell.record(fileIdOf('papers/p.pdf')).revision && expect.stringMatching(/^sha256:/) });
  });
});

describe('a reader whose file changes', () => {
  const reads = () => shell.calls.filter((c) => c.method === 'readView').length;
  const shown = () => view!.container.querySelector<HTMLElement>('[data-reader-text]')?.textContent ?? '';
  let stop = () => {};
  afterEach(() => stop());
  const open = async () => {
    const fileId = seedBytes('notes/draft.docx', docxWith(['VERSION_ONE_T1']));
    stop = await watchWorkspaces(['ws_1']);
    await readerOf('notes/draft.docx');
    expect(shown()).toContain('VERSION_ONE_T1');
    return fileId;
  };
  /** Another program replaces the file's content, and the workspace says so. */
  const replace = (fileId: string, bytes: Uint8Array, marker: string) => during(() => {
    shell.files.get(fileId)!.bytes = bytes;
    shell.editExternally(fileId, marker); // the record's revision follows `content`; what is read is `bytes`
  });

  it('[R2-21] shows what the file holds now, and a quote taken after that is of the new version', async () => {
    const fileId = await open();
    const text = view!.container.querySelector<HTMLElement>('[data-reader-text]')!.firstChild as Text;
    select([text, 0], [text, 7]);
    await replace(fileId, docxWith(['VERSION_TWO_T2 and more']), 'two');
    await until(() => shown().includes('VERSION_TWO_T2'));
    expect(reads(), 'the file was read again').toBe(2);
    expect(shown()).not.toContain('VERSION_ONE_T1');
    expect(window.getSelection()!.toString(), 'what was selected in the old text is not selected in the new').toBe('');

    const now = view!.container.querySelector<HTMLElement>('[data-reader-text]')!.firstChild as Text;
    select([now, 0], [now, 14]);
    await pressQuote();
    const { ref, words } = quoted[0];
    expect(words).toBe('VERSION_TWO_T2');
    expect(ref.selector).toMatchObject({ kind: 'text', quote: 'VERSION_TWO_T2' });
  });

  it('[R2-21] says the file is gone when it is, takes no quote of what it last showed, and shows it again when it is back', async () => {
    const fileId = await open();
    shell.files.get(fileId)!.status = 'missing';
    await during(() => shell.emit({ workspaceId: 'ws_1', fileId, change: 'missing', observedRevision: null, opId: null, record: shell.record(fileId) }));
    await until(() => view!.container.querySelector('[data-reader-gone]'));
    expect(view!.container.querySelector('[data-reader-gone]')).not.toBeNull();
    expect(view!.container.querySelector('[data-reader-quote]')).toBeNull();

    shell.files.get(fileId)!.status = 'ready';
    shell.files.get(fileId)!.bytes = docxWith(['BACK_AGAIN_T3']);
    await during(() => shell.emit({ workspaceId: 'ws_1', fileId, change: 'restored', observedRevision: shell.record(fileId).revision, opId: null, record: shell.record(fileId) }));
    await until(() => shown().includes('BACK_AGAIN_T3'));
    expect(view!.container.querySelector('[data-reader-gone]')).toBeNull();
    expect(shown()).toContain('BACK_AGAIN_T3');
  });

  it('[R2-21] does not read the file again for news of the version it already shows', async () => {
    const fileId = await open();
    await during(() => shell.emit({ workspaceId: 'ws_1', fileId, change: 'moved', observedRevision: shell.record(fileId).revision, opId: null, record: shell.record(fileId) }));
    await during(tick);
    await during(tick);
    expect(reads()).toBe(1);
    expect(shown()).toContain('VERSION_ONE_T1');
  });
});
