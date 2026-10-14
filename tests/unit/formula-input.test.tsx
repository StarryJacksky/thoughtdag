import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { acceptCompletion, currentCompletions, nextSnippetField, startCompletion } from '@codemirror/autocomplete';
import MarkdownEditor from '../../src/components/editors/MarkdownEditor';
import TexEditor from '../../src/components/editors/TexEditor';
import { documents } from '../../src/lib/documents/document-service';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, withoutLayout, type Mounted } from '../helpers/render';

// Typing formulas quickly, in Markdown and in a LaTeX source: the commands
// are offered as they are typed (\fr gives \frac{}{}, the cursor in the
// first place to fill and Tab to the next), a dollar sign comes with the
// one that closes it, Mod-E puts a formula in the line and Mod-Shift-E one
// on lines of its own, and a formula being typed is shown drawn under it.
// Nothing of this changes what is in the file other than what was typed.

let shell: FakeWorkspace;
let view: Mounted | null = null;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await during(tick); };
const editorIn = (root: ParentNode) => EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)!;

beforeAll(() => withoutLayout());
beforeEach(() => { shell = installFakeWorkspace(); });
afterEach(async () => {
  await view?.unmount();
  view = null;
  await documents.dispose();
  shell.uninstall();
});

const open = async (relativePath: string, content: string) => {
  shell.seed(relativePath, content);
  const doc = await documents.open(fileIdOf(relativePath), 'view-1');
  const Editor = relativePath.endsWith('.tex') ? TexEditor : MarkdownEditor;
  view = await mount(<div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><Editor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
  await settle();
  const editor = editorIn(view.container);
  await during(() => { editor.focus(); });
  return { doc, editor };
};
/** Put the cursor at `at` and type `text` there, as the keyboard would (each character through the editor's input handling). */
const type = async (editor: EditorView, text: string, at?: number) => {
  if (at !== undefined) await during(() => { editor.dispatch({ selection: { anchor: at } }); });
  for (const ch of text) {
    await during(() => {
      const { from, to } = editor.state.selection.main;
      const handled = editor.state.facet(EditorView.inputHandler).some((handler) => handler(editor, from, to, ch, () => editor.state.update({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' })));
      if (!handled) editor.dispatch({ changes: { from, to, insert: ch }, selection: { anchor: from + ch.length }, userEvent: 'input.type' });
    });
  }
  await settle();
};
const cursor = (editor: EditorView) => editor.state.selection.main.head;
const textOf = (editor: EditorView) => editor.state.doc.toString();
/** What is offered now: the editor takes what its sources answer after a short wait (about 50 ms). */
const offered = async (editor: EditorView) => {
  await during(() => { startCompletion(editor); });
  for (let i = 0; i < 40 && currentCompletions(editor.state).length === 0; i++) await during(tick);
  return currentCompletions(editor.state).map((c) => c.label);
};
/** Take the first command offered, as Enter would: a list just opened takes no choice for a moment (75 ms), against keys pressed before it was seen. */
const accept = async (editor: EditorView) => {
  await during(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  await during(() => { acceptCompletion(editor); });
  await settle();
};
const press = (editor: EditorView, key: string, shift = false) => during(() => {
  // with Shift held, a keyboard names the letter in capitals
  editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: shift ? key.toUpperCase() : key, keyCode: key.toUpperCase().charCodeAt(0), ctrlKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
});

describe('the commands of a formula', () => {
  it('are offered in a Markdown formula as they are typed, and one taken is filled in with its places to fill', async () => {
    const { editor } = await open('notes/n.md', 'Mean: $$ done\n');
    await type(editor, '\\fr', 'Mean: $'.length);
    expect(await offered(editor)).toContain('\\frac');
    // \frac first: it is what was being typed
    expect(currentCompletions(editor.state)[0].label).toBe('\\frac');
    await accept(editor);
    await settle();
    expect(textOf(editor)).toBe('Mean: $\\frac{}{}$ done\n');
    expect(cursor(editor), 'the cursor is in the first place to fill').toBe('Mean: $\\frac{'.length);
    await type(editor, 'a');
    await during(() => { nextSnippetField(editor); });
    expect(cursor(editor), 'Tab goes to the next').toBe('Mean: $\\frac{a}{'.length);
    await type(editor, 'b');
    expect(textOf(editor)).toBe('Mean: $\\frac{a}{b}$ done\n');
  });

  it('give Greek letters, operators and structures, each named with what it draws', async () => {
    const { editor } = await open('notes/n.md', '$$\n\n$$\n');
    await type(editor, '\\al', 3);
    expect(await offered(editor)).toContain('\\alpha');
    expect(currentCompletions(editor.state).find((c) => c.label === '\\alpha')!.detail).toBe('α');
    await during(() => { editor.dispatch({ changes: { from: 3, to: 6, insert: '' }, selection: { anchor: 3 } }); });
    await type(editor, '\\su', 3);
    expect(await offered(editor)).toEqual(expect.arrayContaining(['\\sum', '\\sum_{}^{}', '\\subset']));
    await during(() => { editor.dispatch({ changes: { from: 3, to: 6, insert: '' }, selection: { anchor: 3 } }); });
    await type(editor, '\\begin{pm', 3);
    expect(await offered(editor)).toContain('\\begin{pmatrix}');
  });

  it('are not offered in the words of a Markdown note, outside its formulas', async () => {
    const { editor } = await open('notes/n.md', 'Some words \n');
    await type(editor, '\\fr', 'Some words '.length);
    expect(await offered(editor)).toEqual([]);
  });

  it('are offered anywhere in a LaTeX source, with its own commands as well', async () => {
    const { editor } = await open('paper/p.tex', '\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n');
    const at = '\\documentclass{article}\n\\begin{document}\n'.length;
    await type(editor, '\\sec', at);
    expect(await offered(editor)).toContain('\\section{}');
    await accept(editor);
    await settle();
    expect(textOf(editor).slice(at)).toBe('\\section{}\n\\end{document}\n');
    expect(cursor(editor)).toBe(at + '\\section{'.length);
  });
});

describe('dollar signs and braces', () => {
  it('a dollar sign typed comes with the one that closes it, and typing it again steps over that one', async () => {
    const { editor } = await open('notes/n.md', 'x \n');
    await type(editor, '$', 2);
    expect(textOf(editor)).toBe('x $$\n');
    expect(cursor(editor)).toBe(3);
    await type(editor, 'a^2$');
    expect(textOf(editor)).toBe('x $a^2$\n');
    expect(cursor(editor), 'the closing one was stepped over, not doubled').toBe('x $a^2$'.length);
  });

  it('a dollar sign typed over selected words makes them a formula', async () => {
    const { editor } = await open('notes/n.md', 'area is pi r^2 here\n');
    await during(() => { editor.dispatch({ selection: { anchor: 'area is '.length, head: 'area is pi r^2'.length } }); });
    await type(editor, '$');
    expect(textOf(editor)).toBe('area is $pi r^2$ here\n');
  });

  it('an escaped dollar, and a dollar after a word, is a dollar and nothing more', async () => {
    const { editor } = await open('notes/n.md', 'costs \\ and US\n');
    await type(editor, '$', 'costs \\'.length);
    expect(textOf(editor)).toBe('costs \\$ and US\n');
    await type(editor, '$', textOf(editor).length - 1);
    expect(textOf(editor)).toBe('costs \\$ and US$\n');
  });

  it('a brace typed in a formula comes with its closing one; in the words around it, it does not', async () => {
    const { editor } = await open('notes/n.md', 'see $x^$ and \n');
    await type(editor, '{', 'see $x^'.length);
    expect(textOf(editor)).toBe('see $x^{}$ and \n');
    await type(editor, '2}');
    expect(textOf(editor)).toBe('see $x^{2}$ and \n');
    await type(editor, '{', textOf(editor).length - 1);
    expect(textOf(editor)).toBe('see $x^{2}$ and {\n');
  });
});

describe('the keys for a formula', () => {
  it('Mod-E puts a formula in the line, around what is selected if anything is', async () => {
    const { editor } = await open('notes/n.md', 'one two\n');
    await during(() => { editor.dispatch({ selection: { anchor: 4 } }); });
    await press(editor, 'e');
    expect(textOf(editor)).toBe('one $$two\n');
    expect(cursor(editor)).toBe(5);
    await during(() => { editor.dispatch({ changes: { from: 4, to: 6, insert: '' }, selection: { anchor: 4, head: 7 } }); });
    await press(editor, 'e');
    expect(textOf(editor)).toBe('one $two$\n');
  });

  it('Mod-Shift-E puts a formula on lines of its own: $$ in Markdown, \\[ \\] in LaTeX', async () => {
    const md = await open('notes/n.md', 'Before it\n');
    await during(() => { md.editor.dispatch({ selection: { anchor: 'Before it'.length } }); });
    await press(md.editor, 'e', true);
    expect(textOf(md.editor)).toBe('Before it\n$$\n\n$$\n');
    expect(cursor(md.editor)).toBe('Before it\n$$\n'.length);
    await view!.unmount();
    view = null;
    const tex = await open('paper/p.tex', 'x\n');
    await during(() => { tex.editor.dispatch({ selection: { anchor: 2 } }); });
    await press(tex.editor, 'e', true);
    expect(textOf(tex.editor)).toBe('x\n\\[\n\n\\]\n');
    expect(cursor(tex.editor)).toBe('x\n\\[\n'.length);
  });

  it('Mod-Shift-M still switches between the page and its source', async () => {
    const { editor } = await open('notes/n.md', '# Title\n');
    expect(view!.container.querySelector('[data-markdown-mode="live"]')!.getAttribute('aria-pressed')).toBe('true');
    await press(editor, 'm', true);
    await settle();
    expect(view!.container.querySelector('[data-markdown-mode="source"]')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('a formula being typed', () => {
  it('is shown drawn under it while the cursor is in it, in Markdown and in LaTeX, and not when it is not', async () => {
    const md = await open('notes/n.md', 'Then $\\frac{a}{b}$ holds.\n');
    await during(() => { md.editor.dispatch({ selection: { anchor: 'Then $\\fr'.length } }); });
    await settle();
    const tip = () => view!.container.querySelector('.cm-tooltip [data-formula-preview]');
    expect(tip()).not.toBeNull();
    expect(tip()!.querySelector('.katex')).not.toBeNull();
    await during(() => { md.editor.dispatch({ selection: { anchor: 1 } }); });
    await settle();
    expect(tip()).toBeNull();
    await view!.unmount();
    view = null;

    const tex = await open('paper/p.tex', 'Let $x^2$ be.\n\\begin{equation}\nE = mc^2\n\\end{equation}\n');
    await during(() => { tex.editor.dispatch({ selection: { anchor: 'Let $x'.length } }); });
    await settle();
    expect(tip()!.querySelector('.katex')).not.toBeNull();
    await during(() => { tex.editor.dispatch({ selection: { anchor: tex.editor.state.doc.toString().indexOf('mc^2') } }); });
    await settle();
    expect(tip()!.querySelector('.katex-display'), 'a display formula is drawn as a display').not.toBeNull();
  });

  it('that does not parse yet is shown as it is, marked, without an error', async () => {
    const { editor } = await open('notes/n.md', 'Then $\\frac{a}{$ holds.\n');
    await during(() => { editor.dispatch({ selection: { anchor: 'Then $\\fr'.length } }); });
    await settle();
    expect(view!.container.querySelector('.cm-tooltip [data-formula-preview]')).not.toBeNull();
  });
});
