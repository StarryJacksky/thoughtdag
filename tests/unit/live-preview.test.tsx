import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import MarkdownEditor from '../../src/components/editors/MarkdownEditor';
import TexEditor from '../../src/components/editors/TexEditor';
import { findMath } from '../../src/components/editors/live-preview';
import { documents } from '../../src/lib/documents/document-service';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, withoutLayout, type Mounted } from '../helpers/render';

// Markdown written the way a notes app shows it: the text itself, laid out
// as it reads (headings large, bold bold, formulas as formulas), with the
// markup showing only where the cursor is. And formulas in a LaTeX source,
// shown as formulas while it is typed. The file is never rewritten by any
// of this: what is on disk is what was typed.

let shell: FakeWorkspace;
let view: Mounted | null = null;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const editorIn = (root: ParentNode) => EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)!;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let i = 0; i < 6; i++) await during(tick); };
const q = (selector: string) => view!.container.querySelector<HTMLElement>(selector);
const all = (selector: string) => [...view!.container.querySelectorAll<HTMLElement>(selector)];
const lineText = (selector: string) => q(selector)?.textContent ?? '';

const NOTE = '# Title\n\nSome **bold** and *slanted* words with `code` and $x^2$ inline.\n\n$$\n\\int_0^1 f(t)\\,dt\n$$\n\n> a quote\n\n- an item\n\n[a link](https://example.org)\n';

beforeAll(() => withoutLayout());
beforeEach(() => {
  shell = installFakeWorkspace();
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  await documents.dispose();
  shell.uninstall();
});

describe('finding formulas', () => {
  const tex = (found: ReturnType<typeof findMath>) => found.map((m) => [m.tex, m.display]);

  it('in Markdown: $…$ and \\(…\\) inline, $$…$$ and \\[…\\] on their own; a dollar that is escaped or is money is not one', () => {
    expect(tex(findMath('a $x^2$ b \\(y\\) c', 'markdown'))).toEqual([['x^2', false], ['y', false]]);
    expect(tex(findMath('$$\n\\int f\n$$\nand \\[ z \\]', 'markdown'))).toEqual([['\n\\int f\n', true], [' z ', true]]);
    expect(tex(findMath('costs \\$5 and \\$6', 'markdown'))).toEqual([]);
    expect(tex(findMath('between $5 and $6 dollars', 'markdown')), 'a closing dollar followed by a digit, or after a space, is not one').toEqual([]);
    expect(tex(findMath('no closing $ here', 'markdown'))).toEqual([]);
  });

  it('in Markdown: nothing inside code is a formula', () => {
    const text = 'see `$not$` and\n\n```\n$also not$\n```\n\nbut $yes$';
    const codeRanges: [number, number][] = [[text.indexOf('`$'), text.indexOf('$`') + 2], [text.indexOf('```'), text.lastIndexOf('```') + 3]];
    expect(tex(findMath(text, 'markdown', (from, to) => codeRanges.some(([a, b]) => from < b && to > a)))).toEqual([['yes', false]]);
  });

  it('in LaTeX: math modes and the display environments, not what is commented out', () => {
    const text = 'Inline $a+b$ and \\(c\\).\n% $commented$\n\\begin{equation}\nE = mc^2\n\\end{equation}\n\\begin{align*}\na &= b \\\\\nc &= d\n\\end{align*}\nEscaped \\$ and 50\\% done $d$.';
    const found = findMath(text, 'tex');
    expect(found.map((m) => m.display)).toEqual([false, false, true, true, false]);
    expect(found[0].tex).toBe('a+b');
    expect(found[2].tex).toBe('\\begin{equation}\nE = mc^2\n\\end{equation}');
    expect(found[3].tex.startsWith('\\begin{align*}')).toBe(true);
    expect(found[4].tex).toBe('d');
    // each is placed where it is in the text, delimiters and all
    for (const m of found) expect(text.slice(m.from, m.to).includes(m.tex)).toBe(true);
  });
});

describe('a Markdown document, as a notes app shows it', () => {
  const open = async (content = NOTE) => {
    shell.seed('notes/note.md', content);
    const doc = await documents.open(fileIdOf('notes/note.md'), 'view-1');
    view = await mount(<div style={{ height: 600, display: 'flex' }}><MarkdownEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    await settle();
    return { doc, editor: editorIn(view.container) };
  };
  /** Put the cursor somewhere, the way clicking there would: the editor has the focus. */
  const putCursor = async (editor: EditorView, at: number) => { await during(() => { editor.focus(); editor.dispatch({ selection: { anchor: at } }); }); await settle(); };

  it('opens laid out as it reads: headings, bold, slanted, code, a quote, a list, a link, and formulas drawn as formulas', async () => {
    const { editor } = await open();
    await putCursor(editor, editor.state.doc.length); // the cursor is at the end, away from all of it
    expect(q('[data-markdown-mode="live"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(lineText('.cm-md-h1')).toBe('Title');
    expect(lineText('.cm-md-strong')).toBe('bold');
    expect(lineText('.cm-md-em')).toBe('slanted');
    expect(lineText('.cm-md-code')).toBe('code');
    expect(lineText('.cm-md-quote')).toBe('a quote');
    expect(q('.cm-md-bullet')).not.toBeNull();
    expect(lineText('.cm-md-link')).toBe('a link');
    expect(q('.cm-math-inline .katex')).not.toBeNull();
    expect(q('.cm-math-block .katex-display')).not.toBeNull();
    // none of the markup shows where the cursor is not
    const shown = q('.cm-content')!.textContent!;
    for (const markup of ['# Title', '**', '`code`', '$x^2$', '](https']) expect(shown, markup).not.toContain(markup);
  });

  it('shows the markup of what the cursor is in, and only that', async () => {
    const { editor } = await open();
    await putCursor(editor, NOTE.indexOf('x^2') + 1);
    expect(q('.cm-content')!.textContent).toContain('$x^2$');
    expect(q('.cm-math-inline'), 'the formula the cursor is in is its source').toBeNull();
    expect(q('.cm-math-block .katex-display'), 'the other is still drawn').not.toBeNull();
    expect(q('.cm-content')!.textContent).not.toContain('# Title');
    await putCursor(editor, 2);
    expect(q('.cm-content')!.textContent).toContain('# Title');
  });

  it('is typed into as text: what is typed is the document, and the file is what was typed, markup and all', async () => {
    const { doc, editor } = await open('Start\n');
    await during(() => { editor.dispatch({ changes: { from: editor.state.doc.length, insert: '\n## Next\n\nwith $a_1$\n' }, selection: { anchor: 0 }, userEvent: 'input.type' }); });
    await settle();
    expect(documents.get(doc.documentId)!.text).toBe('Start\n\n## Next\n\nwith $a_1$\n');
    expect(lineText('.cm-md-h2')).toBe('Next');
    expect(q('.cm-math-inline .katex')).not.toBeNull();
    expect((await documents.save(doc.documentId)).status).toBe('saved');
    expect(shell.files.get(fileIdOf('notes/note.md'))!.content).toBe('Start\n\n## Next\n\nwith $a_1$\n');
  });

  it('is laid out from top to bottom while nobody is typing in it, wherever the cursor was left', async () => {
    const { editor } = await open();
    await putCursor(editor, 2);
    expect(q('.cm-content')!.textContent).toContain('# Title');
    await during(() => { editor.contentDOM.blur(); });
    await settle();
    expect(q('.cm-content')!.textContent, 'the person is not typing here: nothing is shown as markup').not.toContain('# Title');
    expect(lineText('.cm-md-h1')).toBe('Title');
  });

  it('looks like a page of notes, not like code: no line numbers, the text face', async () => {
    await open();
    expect(q('.cm-lineNumbers')).toBeNull();
    expect(q('[data-editor-face]')!.dataset.editorFace).toBe('text');
    expect(q('[data-editor-look]')!.dataset.editorLook).toBe('notes');
  });

  it('can show the source as it is, and the page as it reads', async () => {
    const { editor } = await open();
    await putCursor(editor, editor.state.doc.length);
    await during(() => q('[data-markdown-mode="source"]')!.click());
    await settle();
    expect(q('.cm-content')!.textContent).toContain('# Title');
    expect(q('.cm-math-inline')).toBeNull();
    await during(() => q('[data-markdown-mode="reading"]')!.click());
    await settle();
    expect(q('.cm-editor'), 'reading: nothing to type into').toBeNull();
    expect(q('[data-markdown-preview] h1')!.textContent).toBe('Title');
    expect(q('[data-markdown-preview] .katex')).not.toBeNull();
  });

  it('draws no formula that could do anything: a link in a formula goes nowhere', async () => {
    const { editor } = await open('A $\\href{javascript:alert(1)}{click}$ formula.\n');
    await putCursor(editor, editor.state.doc.length);
    expect(q('.cm-math-inline')).not.toBeNull();
    expect(all('.cm-math-inline a').filter((a) => (a.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'))).toEqual([]);
  });
});

describe('a LaTeX source', () => {
  const SOURCE = '\\section{Method}\nThe mean is $\\bar x$ here.\n% $not this$\n\\begin{equation}\nE = mc^2\n\\end{equation}\n';
  const open = async () => {
    shell.seed('notes/paper.tex', SOURCE);
    const doc = await documents.open(fileIdOf('notes/paper.tex'), 'view-1');
    view = await mount(<div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><TexEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    await settle();
    const editor = editorIn(view.container);
    await during(() => { editor.dispatch({ selection: { anchor: 0 } }); });
    await settle();
    return { doc, editor };
  };

  it('shows its formulas drawn while it is typed, and leaves the rest as source', async () => {
    const { doc } = await open();
    expect(q('.cm-math-inline .katex')).not.toBeNull();
    expect(q('.cm-math-block .katex-display')).not.toBeNull();
    expect(q('.cm-content')!.textContent).toContain('\\section{Method}');
    expect(q('.cm-content')!.textContent).toContain('% $not this$');
    expect(q('.cm-lineNumbers'), 'it is still a source, with its line numbers').not.toBeNull();
    expect(documents.get(doc.documentId)!.text).toBe(SOURCE);
  });

  it('turns the drawing off and on, with its button and with Mod-Shift-M', async () => {
    const { editor } = await open();
    const toggle = q('[data-math-toggle]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await during(() => toggle.click());
    await settle();
    expect(q('.cm-math-inline')).toBeNull();
    expect(q('.cm-content')!.textContent).toContain('$\\bar x$');
    await during(() => { editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'M', keyCode: 77, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(q('[data-math-toggle]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('.cm-math-inline .katex')).not.toBeNull();
  });
});
