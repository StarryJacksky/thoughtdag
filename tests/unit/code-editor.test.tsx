import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import CodeEditor from '../../src/components/editors/CodeEditor';
import TexEditor from '../../src/components/editors/TexEditor';
import { documents } from '../../src/lib/documents/document-service';
import { closeSurface, useSurfaces } from '../../src/lib/documents/surface-store';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, withoutLayout, type Mounted } from '../helpers/render';

// A file of code, in an editor made for code: a light one in the manner of
// the editors programmers use (line numbers, folding, find, where the
// cursor is) with a run button and the run's output under the code. And a
// LaTeX source compiled to a PDF that opens beside it. Runs are observed
// at a stand-in for the desktop shell: what is checked is what the page
// asks for and what it shows of the answer.

let shell: FakeWorkspace;
let view: Mounted | null = null;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await during(tick); };
const q = (selector: string, root: ParentNode = view!.container) => root.querySelector<HTMLElement>(selector);
const editorIn = (root: ParentNode) => EditorView.findFromDOM(root.querySelector<HTMLElement>('.cm-editor')!)!;

beforeAll(() => withoutLayout());
beforeEach(() => {
  shell = installFakeWorkspace();
  useSurfaces.setState({ surfaces: [], order: [], container: { width: 1400, height: 900 }, active: { surfaceId: null, turn: 0 } });
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
  await documents.dispose();
  shell.uninstall();
});

const openCode = async (relativePath: string, content: string, surfaceId = 'view-1') => {
  shell.seed(relativePath, content);
  const doc = await documents.open(fileIdOf(relativePath), surfaceId);
  view = await mount(<div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><CodeEditor documentId={doc.documentId} surfaceId={surfaceId} onSave={() => {}} /></div>);
  await settle();
  return doc;
};

describe('a file of code', () => {
  it('opens in an editor for code: its language, line numbers, folding, the mono face, and where the cursor is', async () => {
    await openCode('src/stats.py', 'def mean(xs):\n    return sum(xs) / len(xs)\n');
    expect(q('[data-code-language]')!.textContent).toBe('Python');
    expect(q('.cm-lineNumbers')).not.toBeNull();
    expect(q('.cm-foldGutter')).not.toBeNull();
    expect(q('[data-editor-face]')!.dataset.editorFace).toBe('code');
    expect(q('[data-code-cursor]')!.textContent).toMatch(/1.*1/);
    const editor = editorIn(view!.container);
    await during(() => { editor.dispatch({ selection: { anchor: editor.state.doc.line(2).from + 4 } }); });
    expect(q('[data-code-cursor]')!.textContent).toMatch(/2.*5/);
  });

  it('finds and replaces with the keys programmers know', async () => {
    await openCode('src/stats.py', 'x = 1\n');
    const editor = editorIn(view!.container);
    await during(() => { editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', keyCode: 70, ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(q('.cm-search')).not.toBeNull();
  });

  it('is run when the run button is pressed, after what was typed is saved, and its output is shown under it, errors apart', async () => {
    const doc = await openCode('src/stats.py', 'print(1)\n');
    await during(() => { documents.setText(doc.documentId, 'print(2)\n', 'view-1'); });
    expect(q('[data-run-output]'), 'no output panel before anything ran').toBeNull();
    await during(() => q('[data-code-run]')!.click());
    await settle();
    // saved first, then run: what runs is what is on the screen
    const order = shell.calls.map((c) => c.method).filter((m) => m === 'saveText' || m === 'runFile');
    expect(order).toEqual(['saveText', 'runFile']);
    expect(shell.files.get(fileIdOf('src/stats.py'))!.content).toBe('print(2)\n');
    const output = q('[data-run-output]')!;
    expect(q('[data-run-stream="stdout"]', output)!.textContent).toContain('FAKE_STDOUT_LINE');
    expect(q('[data-run-stream="stderr"]', output)!.textContent).toContain('FAKE_STDERR_LINE');
    expect(q('[data-run-status]', output)!.dataset.runStatus).toBe('ok');
    expect(q('[data-run-command]', output)!.textContent).toContain('python3');
  });

  it('is stopped with the stop button while it runs', async () => {
    shell.runAnswer = (fileId, runId) => [{ runId, type: 'start', fileId, command: 'python3 -u slow.py' }, { runId, type: 'output', stream: 'stdout', text: 'WORKING\n' }];
    await openCode('src/slow.py', 'import time\ntime.sleep(60)\n');
    await during(() => q('[data-code-run]')!.click());
    await settle();
    expect(q('[data-code-run]'), 'while it runs there is no second run button').toBeNull();
    await during(() => q('[data-code-stop]')!.click());
    await settle();
    expect(shell.stopped).toEqual([shell.runs[0].runId]);
    expect(q('[data-run-status]')!.dataset.runStatus).toBe('stopped');
    expect(q('[data-code-run]')).not.toBeNull();
  });

  it('says which tool is missing instead of offering to run with it', async () => {
    shell.seed('src/prog.rs', 'fn main() {}\n');
    const answer = window.desktopWorkspace!.runTools;
    window.desktopWorkspace!.runTools = async () => ({ kind: 'compiled', label: 'Rust', needs: ['rustc'], missing: ['rustc'] });
    try {
      const doc = await documents.open(fileIdOf('src/prog.rs'), 'view-1');
      view = await mount(<div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><CodeEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
      await settle();
      expect(q('[data-code-missing]')!.textContent).toContain('rustc');
      expect((q('[data-code-run]') as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
    } finally { window.desktopWorkspace!.runTools = answer; }
  });

  it('that nothing runs (data, a config) has the code editor and no run button', async () => {
    await openCode('config/settings.json', '{ "a": 1 }\n');
    expect(q('.cm-lineNumbers')).not.toBeNull();
    expect(q('[data-code-run]')).toBeNull();
  });

  it('shows only its own run: two files running side by side do not share their output', async () => {
    shell.seed('src/one.py', 'print(1)\n');
    shell.seed('src/two.py', 'print(2)\n');
    shell.runAnswer = (fileId, runId) => [
      { runId, type: 'start', fileId, command: 'python3' },
      { runId, type: 'output', stream: 'stdout', text: `OUTPUT_OF_${shell.files.get(fileId)!.relativePath}\n` },
      { runId, type: 'end', status: 'ok', code: 0, ms: 1 },
    ];
    const one = await documents.open(fileIdOf('src/one.py'), 'view-1');
    const two = await documents.open(fileIdOf('src/two.py'), 'view-2');
    view = await mount(<div>
      <div data-pane="one" style={{ height: 400, display: 'flex', flexDirection: 'column' }}><CodeEditor documentId={one.documentId} surfaceId="view-1" onSave={() => {}} /></div>
      <div data-pane="two" style={{ height: 400, display: 'flex', flexDirection: 'column' }}><CodeEditor documentId={two.documentId} surfaceId="view-2" onSave={() => {}} /></div>
    </div>);
    await settle();
    await during(() => { q('[data-pane="one"] [data-code-run]')!.click(); q('[data-pane="two"] [data-code-run]')!.click(); });
    await settle();
    expect(q('[data-pane="one"] [data-run-output]')!.textContent).toContain('OUTPUT_OF_src/one.py');
    expect(q('[data-pane="one"] [data-run-output]')!.textContent).not.toContain('two.py');
    expect(q('[data-pane="two"] [data-run-output]')!.textContent).toContain('OUTPUT_OF_src/two.py');
  });
});

describe('a LaTeX source', () => {
  it('is compiled to a PDF that opens beside it, and compiling again keeps that reader', async () => {
    shell.seed('paper/main.tex', '\\documentclass{article}\\begin{document}Hi\\end{document}\n');
    shell.seed('paper/main.pdf', '');
    const pdf = fileIdOf('paper/main.pdf');
    shell.runAnswer = (fileId, runId) => [
      { runId, type: 'start', fileId, command: 'latexmk -xelatex main.tex' },
      { runId, type: 'output', stream: 'stdout', text: 'Output written on main.pdf\n' },
      { runId, type: 'end', status: 'ok', code: 0, ms: 900, output: pdf },
    ];
    const doc = await documents.open(fileIdOf('paper/main.tex'), 'view-1');
    view = await mount(<div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><TexEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    await settle();
    await during(() => q('[data-code-run]')!.click());
    await settle();
    expect(q('[data-run-status]')!.dataset.runStatus).toBe('ok');
    const readers = () => useSurfaces.getState().surfaces.filter((s) => s.fileId === pdf);
    expect(readers().map((s) => [s.reading, s.placement])).toEqual([[true, 'right']]);
    await during(() => q('[data-code-run]')!.click());
    await settle();
    expect(readers().length, 'the PDF already open is the one that shows the new one').toBe(1);
  });

  it('that does not compile shows why, and opens nothing', async () => {
    shell.seed('paper/main.tex', '\\nosuchcommand\n');
    shell.runAnswer = (fileId, runId) => [
      { runId, type: 'start', fileId, command: 'latexmk' },
      { runId, type: 'output', stream: 'stderr', text: './main.tex:1: Undefined control sequence.\n' },
      { runId, type: 'end', status: 'failed', code: 12, ms: 300 },
    ];
    const doc = await documents.open(fileIdOf('paper/main.tex'), 'view-1');
    view = await mount(<div style={{ height: 600, display: 'flex', flexDirection: 'column' }}><TexEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    await settle();
    await during(() => q('[data-code-run]')!.click());
    await settle();
    expect(q('[data-run-status]')!.dataset.runStatus).toBe('failed');
    expect(q('[data-run-stream="stderr"]')!.textContent).toContain('Undefined control sequence');
    expect(useSurfaces.getState().surfaces).toEqual([]);
  });
});
