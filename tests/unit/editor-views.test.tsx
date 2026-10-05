import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import MarkdownEditor from '../../src/components/editors/MarkdownEditor';
import TextEditor from '../../src/components/editors/TextEditor';
import ResourceReader from '../../src/components/readers/ResourceReader';
import SurfaceManager from '../../src/components/surfaces/SurfaceManager';
import { quoteOnCanvas } from '../../src/components/workspace/actions';
import { documents } from '../../src/lib/documents/document-service';
import { pdfQuote, textQuote } from '../../src/lib/documents/quotes';
import { closeSurface, openFileSurface, useSurfaces } from '../../src/lib/documents/surface-store';
import { validateDTO, type ResourceRef } from '../../src/lib/workspace/contracts';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, keyHeardByWindow, mount, withoutLayout, type Mounted } from '../helpers/render';

// The editors and readers a surface shows: that typing in an editor is an
// edit of the shared document and nothing else, that a word being composed
// is not sent half-made, and that what a file contains is shown and never
// run.

let shell: FakeWorkspace;
let view: Mounted | null = null;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const editorIn = (root: ParentNode) => EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)!;
/** Type at a place in an editor the way the editor reports typing. */
const type = (editor: EditorView, at: number, text: string, userEvent = 'input.type') => editor.dispatch({ changes: { from: at, insert: text }, userEvent });
const key = (editor: EditorView, init: KeyboardEventInit) => editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeAll(async () => {
  withoutLayout();
  await bootProjects();
});
beforeEach(() => {
  shell = installFakeWorkspace();
  shell.seed('notes/a.md', 'FIRST_LINE_K4\n');
  useSurfaces.setState({ surfaces: [], order: [], container: { width: 1200, height: 800 } });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-1', switching: false });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
  await documents.dispose();
  shell.uninstall();
});

describe('an editor is a view of the shared document', () => {
  const open = async () => {
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    let saved = 0;
    view = await mount(<div style={{ height: 300 }}><TextEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => { saved++; }} /></div>);
    return { doc, editor: editorIn(view.container), saved: () => saved };
  };

  it('shows the document\'s text, and what is typed in it becomes an edit of the document from this view', async () => {
    const { doc, editor } = await open();
    expect(editor.state.doc.toString()).toBe('FIRST_LINE_K4\n');
    const heard: (string | null)[] = [];
    documents.subscribe(doc.documentId, (_model, change) => { if (change.kind === 'edit') heard.push(change.originSurfaceId); });
    await during(() => type(editor, 14, 'typed here\n'));
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'FIRST_LINE_K4\ntyped here\n', bufferRevision: 1, state: 'dirty' });
    expect(heard).toEqual(['view-1']);
  });

  it('shows what another view types, and does not send it back as typing of its own', async () => {
    const { doc, editor } = await open();
    await documents.open(fileIdOf('notes/a.md'), 'view-2');
    await during(() => { documents.applyEdit(doc.documentId, { baseBufferRevision: 0, changes: [{ from: 0, to: 5, insert: 'SECOND' }], originSurfaceId: 'view-2' }); });
    expect(editor.state.doc.toString()).toBe('SECOND_LINE_K4\n');
    expect(documents.get(doc.documentId)!.bufferRevision, 'one edit happened, not two').toBe(1);
    // and typing here afterwards is made on the revision the editor has caught up to
    await during(() => type(editor, 0, '# '));
    expect(documents.get(doc.documentId)).toMatchObject({ text: '# SECOND_LINE_K4\n', bufferRevision: 2 });
  });

  it('has no undo of its own: its undo key takes back the document\'s last step, whoever made it', async () => {
    const { doc, editor } = await open();
    await documents.open(fileIdOf('notes/a.md'), 'view-2');
    await during(() => type(editor, 14, 'mine\n'));
    await tick();
    await during(() => { documents.applyEdit(doc.documentId, { baseBufferRevision: 1, changes: [{ from: 19, to: 19, insert: 'theirs\n' }], originSurfaceId: 'view-2' }); });
    await during(() => { key(editor, { key: 'z', ctrlKey: true }); });
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\nmine\n');
    expect(editor.state.doc.toString()).toBe('FIRST_LINE_K4\nmine\n');
    await during(() => { key(editor, { key: 'z', ctrlKey: true }); });
    expect(editor.state.doc.toString()).toBe('FIRST_LINE_K4\n');
    // with shift held a keyboard sends the capital letter: that is the redo key
    await during(() => { key(editor, { key: 'Z', keyCode: 90, ctrlKey: true, shiftKey: true }); });
    expect(editor.state.doc.toString()).toBe('FIRST_LINE_K4\nmine\n');
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\nmine\n');
  });

  it('asks for a save with the save key, and types nothing', async () => {
    const { editor, saved } = await open();
    await during(() => { key(editor, { key: 's', ctrlKey: true }); });
    expect(saved()).toBe(1);
    expect(editor.state.doc.toString()).toBe('FIRST_LINE_K4\n');
  });

  it('cannot be typed into when the document is read-only, and shows the document\'s text whatever is tried', async () => {
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'readonly';
    const { doc, editor } = await open();
    expect(editor.state.readOnly).toBe(true);
    // something gets a change into the editor all the same: the document does not take it, and the editor is put right
    await during(() => type(editor, 0, 'forced '));
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\n');
    expect(editor.state.doc.toString()).toBe('FIRST_LINE_K4\n');
  });

  it('follows the document when the file is reloaded underneath it', async () => {
    const { doc, editor } = await open();
    shell.files.get(fileIdOf('notes/a.md'))!.content = 'CHANGED_ELSEWHERE_M2\n';
    await during(async () => {
      documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId: doc.fileId, change: 'content', observedRevision: fakeRevision('CHANGED_ELSEWHERE_M2\n'), opId: null, record: shell.record(doc.fileId) });
      await tick();
    });
    expect(editor.state.doc.toString()).toBe('CHANGED_ELSEWHERE_M2\n');
    expect(documents.get(doc.documentId)!.state).toBe('clean');
  });
});

describe('a word being composed by an input method', () => {
  const compose = async (editor: EditorView, steps: string[]) => {
    editor.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    let length = 0;
    for (const step of steps) {
      await during(() => editor.dispatch({ changes: { from: 14, to: 14 + length, insert: step }, userEvent: 'input.type.compose' }));
      length = step.length;
    }
  };
  const finish = async (editor: EditorView) => {
    await during(async () => { editor.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await tick(); });
  };

  it('is not sent while it is half-made, and is one edit, and one step to undo, when it is done', async () => {
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    view = await mount(<div><TextEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    const editor = editorIn(view.container);
    await compose(editor, ['n', 'ni', 'ni h', 'ni hao', '你好']);
    expect(editor.state.doc.toString()).toBe('FIRST_LINE_K4\n你好');
    expect(documents.get(doc.documentId), 'the document has heard nothing of the half-made word').toMatchObject({ text: 'FIRST_LINE_K4\n', bufferRevision: 0, state: 'clean' });
    expect(shell.calls.filter((c) => c.method === 'putDraft' || c.method === 'saveText')).toEqual([]);

    await finish(editor);
    expect(documents.get(doc.documentId)).toMatchObject({ text: 'FIRST_LINE_K4\n你好', bufferRevision: 1 });
    documents.undo(doc.documentId, 'view-1');
    expect(documents.get(doc.documentId)!.text, 'the whole word goes in one step, not letter by letter').toBe('FIRST_LINE_K4\n');
  });

  it('does not reach the canvas: the keys that pick the word never send a question or undo something there', async () => {
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    // the editor as it sits in a surface: inside a frame that keeps what is typed in it to itself
    const id = await openFileSurface(fileIdOf('notes/a.md'));
    view = await mount(<SurfaceManager />);
    const editor = editorIn(view.container.querySelector(`[data-surface="${id}"]`)!);
    editor.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    for (const init of [{ key: 'Process', isComposing: true }, { key: 'Enter', isComposing: true }, { key: ' ', isComposing: true }, { key: 'z', ctrlKey: true }, { key: 'z', metaKey: true }, { key: 'Enter' }, { key: 'Backspace' }]) {
      expect(keyHeardByWindow(editor.contentDOM, init), JSON.stringify(init)).toBe(false);
    }
    expect(documents.get(doc.documentId)!.text).toBe('FIRST_LINE_K4\n');
  });

  it('lands in the right place when the document changed while it was being composed, and the other change is kept', async () => {
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    await documents.open(fileIdOf('notes/a.md'), 'view-2');
    view = await mount(<div><TextEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    const editor = editorIn(view.container);
    await compose(editor, ['n', '你']);
    // meanwhile another view puts a title at the top
    await during(() => { documents.applyEdit(doc.documentId, { baseBufferRevision: 0, changes: [{ from: 0, to: 0, insert: '# Title\n' }], originSurfaceId: 'view-2' }); });
    expect(editor.state.doc.toString(), 'the editor is not disturbed while the word is being made').toBe('FIRST_LINE_K4\n你');
    await finish(editor);
    expect(documents.get(doc.documentId)!.text).toBe('# Title\nFIRST_LINE_K4\n你');
    expect(editor.state.doc.toString()).toBe('# Title\nFIRST_LINE_K4\n你');
  });
});

describe('a Markdown document', () => {
  it('reads as it is typed: the preview is the buffer, rendered', async () => {
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    view = await mount(<div><MarkdownEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    await during(() => view!.container.querySelector<HTMLElement>('[data-markdown-mode="split"]')!.click());
    const editor = editorIn(view.container);
    await during(() => type(editor, 0, '# A heading\n\nSome **bold** words.\n\n'));
    const preview = view.container.querySelector<HTMLElement>('[data-markdown-preview]')!;
    expect(preview.querySelector('h1')?.textContent).toBe('A heading');
    expect(preview.querySelector('strong')?.textContent).toBe('bold');
  });

  it('shows markup that is in the file and runs none of it', async () => {
    const hostile = 'Before.\n\n<script>window.__ranFromMarkdown = true</script>\n\n<img src="x" onerror="window.__ranFromMarkdown = true">\n\n[a link](javascript:window.__ranFromMarkdown=true)\n';
    shell.files.get(fileIdOf('notes/a.md'))!.content = hostile;
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    view = await mount(<div><MarkdownEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    await during(() => view!.container.querySelector<HTMLElement>('[data-markdown-mode="preview"]')!.click());
    const preview = view.container.querySelector<HTMLElement>('[data-markdown-preview]')!;
    expect(preview.textContent).toContain('Before.');
    expect(preview.querySelector('script')).toBeNull();
    expect([...preview.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name)).filter((name) => name.startsWith('on'))).toEqual([]);
    expect([...preview.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '').filter((href) => href.trim().toLowerCase().startsWith('javascript:'))).toEqual([]);
    await tick();
    expect((window as unknown as { __ranFromMarkdown?: boolean }).__ranFromMarkdown).toBeUndefined();
  });
});

describe('a file that is read, not typed into', () => {
  const whole = (fileId: string): ResourceRef => ({ fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' });

  it('an HTML page is shown through a sandbox that runs no script, with its scripts and handlers taken out', async () => {
    shell.seed('notes/page.html', '<html><body><h1>Shown</h1><script>parent.__ranFromHtml = true</script><p onclick="parent.__ranFromHtml = true">text</p></body></html>');
    view = await mount(<div><ResourceReader resourceRef={whole(fileIdOf('notes/page.html'))} name="page.html" /></div>);
    await during(async () => { for (let i = 0; i < 40 && !view!.container.querySelector('iframe'); i++) await tick(); });
    const frames = [...view.container.querySelectorAll('iframe')];
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.getAttribute('sandbox') ?? '', 'the sandbox does not allow scripts').not.toContain('allow-scripts');
      const shown = frame.getAttribute('srcdoc') ?? '';
      expect(shown).toContain('Shown');
      expect(shown.toLowerCase()).not.toContain('<script');
      expect(shown.toLowerCase()).not.toContain('onclick');
    }
    expect((window as unknown as { __ranFromHtml?: boolean }).__ranFromHtml).toBeUndefined();
  });

  it('opens in a surface with a reader and no document: nothing of it can be typed into or saved', async () => {
    shell.seed('figures/plot.png', '');
    shell.files.get(fileIdOf('figures/plot.png'))!.bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const id = await openFileSurface(fileIdOf('figures/plot.png'));
    const surface = useSurfaces.getState().surfaces.find((s) => s.surfaceId === id)!;
    expect(surface).toMatchObject({ kind: 'image', reading: true, notice: null });
    expect(documents.documentOf(fileIdOf('figures/plot.png'))).toBeUndefined();
    expect(shell.calls.filter((c) => c.method === 'readText')).toEqual([]);
  });

  it('a Word document shows the text taken out of it and says that is what it is', async () => {
    // a real .docx is a zip; the reader is given one that cannot be read, and must say so rather than show nothing
    shell.seed('notes/draft.docx', '');
    shell.files.get(fileIdOf('notes/draft.docx'))!.bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const id = await openFileSurface(fileIdOf('notes/draft.docx'));
    expect(useSurfaces.getState().surfaces.find((s) => s.surfaceId === id)).toMatchObject({ reading: true });
    view = await mount(<div><ResourceReader resourceRef={whole(fileIdOf('notes/draft.docx'))} name="draft.docx" /></div>);
    await during(async () => { for (let i = 0; i < 40 && view!.container.querySelector('[data-reader-loading]'); i++) await tick(); });
    expect(view.container.querySelector('[data-reader-failed], [data-reader-derived]')).not.toBeNull();
    expect(view.container.querySelector('.cm-editor')).toBeNull();
  });
});

describe('a file that cannot be opened to type into', () => {
  it('a text file above the limit opens a surface that says so and offers to show the file, and no document is opened', async () => {
    shell.seed('data/huge.csv', 'a,b\n');
    shell.failNext('readText', 'too-large', 'the file is too large to be read here');
    const id = await openFileSurface(fileIdOf('data/huge.csv'));
    expect(useSurfaces.getState().surfaces.find((s) => s.surfaceId === id)).toMatchObject({ notice: 'too-large', reading: false });
    expect(documents.documentOf(fileIdOf('data/huge.csv'))).toBeUndefined();
    view = await mount(<SurfaceManager />);
    const frame = view.container.querySelector<HTMLElement>(`[data-surface="${id}"]`)!;
    expect(frame.querySelector('[data-surface-notice="too-large"]')).not.toBeNull();
    expect(frame.querySelector('.cm-editor')).toBeNull();
    await during(() => frame.querySelector<HTMLElement>('[data-surface-reveal]')!.click());
    expect(shell.calls.filter((c) => c.method === 'reveal').map((c) => c.args)).toEqual([[fileIdOf('data/huge.csv')]]);
  });

  it('a file that is not text says that it is not', async () => {
    shell.seed('data/blob.bin', '');
    shell.failNext('readText', 'not-text', 'the file is not text that can be opened for editing');
    const id = await openFileSurface(fileIdOf('data/blob.bin'));
    expect(useSurfaces.getState().surfaces.find((s) => s.surfaceId === id)).toMatchObject({ notice: 'not-text' });
  });
});

describe('a quote', () => {
  it('of a PDF names the page it is from, and is a reference the contract accepts', () => {
    const ref = pdfQuote('file_1', 7)!;
    expect(ref).toEqual({ fileId: 'file_1', selector: { kind: 'pdf', pages: [7] }, version: { kind: 'live' }, payload: 'text' });
    expect(validateDTO('ResourceRef', ref).ok).toBe(true);
    expect(validateDTO('ResourceRef', pdfQuote('file_1', 2, [0.1, 0.2, 0.6, 0.4])).ok).toBe(true);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(pdfQuote('file_1', bad)).toBeNull();
  });

  it('of text names the passage by its own words and what is around them, never by a line number alone', () => {
    const text = 'one\ntwo trimmed mean three\nfour\n';
    const at = text.indexOf('trimmed mean');
    const ref = textQuote('file_1', text, at, at + 'trimmed mean'.length, fakeRevision(text))!;
    expect(ref.selector).toEqual({ kind: 'text', quote: 'trimmed mean', prefix: 'one\ntwo ', suffix: ' three\nfour\n', baseRevision: fakeRevision(text), lines: [2, 2] });
    expect(validateDTO('ResourceRef', ref).ok).toBe(true);
    expect(textQuote('file_1', text, 5, 5, fakeRevision(text)), 'nothing selected is nothing to quote').toBeNull();
    // the same reference whichever way the selection was dragged
    expect(textQuote('file_1', text, at + 12, at, fakeRevision(text))).toEqual(ref);
  });

  it('lands on the canvas as a note with the words and where they are from, wired to nothing, and remembers what it quotes', () => {
    const ref = pdfQuote('file_1', 3)!;
    const id = quoteOnCanvas(ref, 'A robust estimate:\ndrop the tails.', 'paper.pdf', { x: 100, y: 100 })!;
    const note = useStore.getState().nodes.find((n) => n.id === id)!;
    expect(note.data.stepKind).toBe('note');
    expect(note.data.question).toBe('> A robust estimate:\n> drop the tails.\n\n(paper.pdf p.3)');
    expect(note.data.quoteRef).toEqual(ref);
    expect(note.data.resourceRef, 'a quote is a note, not a node that stands for the file').toBeUndefined();
    expect(useStore.getState().edges).toEqual([]);
    expect(quoteOnCanvas(ref, '   ', 'paper.pdf', { x: 0, y: 0 })).toBeNull();
  });
});
