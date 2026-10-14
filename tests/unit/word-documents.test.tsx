import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { latexToOmml } from '../../src/lib/docx/omml';
import { ommlToMathml } from '../../src/lib/docx/mathml';
import { markdownToDocx } from '../../src/lib/docx/write';
import { readDocx } from '../../src/lib/docx/read';
import MarkdownEditor from '../../src/components/editors/MarkdownEditor';
import ResourceReader from '../../src/components/readers/ResourceReader';
import { documents } from '../../src/lib/documents/document-service';
import { closeSurface, useSurfaces } from '../../src/lib/documents/surface-store';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, withoutLayout, type Mounted } from '../helpers/render';

// Word documents with formulas. A Markdown note is written with LaTeX
// formulas and made into a Word document whose formulas are Word's own
// (OMML: they can be edited in Word as formulas); a Word document that has
// formulas is read with its formulas drawn, and what is quoted from it is
// the words as shown. The documents here are made in the test; nothing is
// read from a real file.

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const MML = 'http://www.w3.org/1998/Math/MathML';
const parse = (omml: string) => new DOMParser().parseFromString(`<root xmlns:m="${M}">${omml}</root>`, 'application/xml');
/** The names of the OMML elements in a formula, in document order, without their prefix. */
const ommlNames = (omml: string) => [...parse(omml).getElementsByTagNameNS(M, '*')].map((e) => e.localName);
const textOf = (omml: string) => [...parse(omml).getElementsByTagNameNS(M, 't')].map((e) => e.textContent).join('');
const roundTrip = (tex: string, display = false) => {
  const omml = parse(latexToOmml(tex)).getElementsByTagNameNS(M, 'oMath')[0];
  return ommlToMathml(omml, display, document);
};
const mathNames = (math: Element) => [math, ...math.getElementsByTagNameNS(MML, '*')].map((e) => e.localName);

describe('a LaTeX formula, as Word writes formulas', () => {
  it('is a formula of Word\'s own: fractions, scripts, roots', () => {
    expect(ommlNames(latexToOmml('\\frac{a}{b}'))).toEqual(expect.arrayContaining(['oMath', 'f', 'num', 'den']));
    expect(textOf(latexToOmml('\\frac{a}{b}'))).toBe('ab');
    expect(ommlNames(latexToOmml('x^2'))).toEqual(expect.arrayContaining(['sSup', 'e', 'sup']));
    expect(ommlNames(latexToOmml('x_i'))).toEqual(expect.arrayContaining(['sSub', 'sub']));
    expect(ommlNames(latexToOmml('x_i^2'))).toEqual(expect.arrayContaining(['sSubSup', 'sub', 'sup']));
    const root = latexToOmml('\\sqrt{x}');
    expect(ommlNames(root)).toEqual(expect.arrayContaining(['rad', 'degHide']));
    const cube = latexToOmml('\\sqrt[3]{x}');
    expect(ommlNames(cube)).toContain('deg');
    expect(textOf(cube)).toBe('3x');
  });

  it('writes a sum or an integral as an n-ary operator with its limits and what it applies to', () => {
    const sum = parse(latexToOmml('\\sum_{i=1}^{n} x_i'));
    const nary = sum.getElementsByTagNameNS(M, 'nary')[0];
    expect(nary).toBeDefined();
    expect(nary.getElementsByTagNameNS(M, 'chr')[0].getAttributeNS(M, 'val')).toBe('∑');
    expect(nary.getElementsByTagNameNS(M, 'sub')[0].textContent).toBe('i=1');
    expect(nary.getElementsByTagNameNS(M, 'sup')[0].textContent).toBe('n');
    expect([...nary.children].find((c) => c.localName === 'e')!.textContent, 'what it sums').toBe('xi');
    const integral = parse(latexToOmml('\\int_0^1 f(t)\\,dt')).getElementsByTagNameNS(M, 'nary')[0];
    expect(integral.getElementsByTagNameNS(M, 'chr')[0].getAttributeNS(M, 'val')).toBe('∫');
  });

  it('writes accents, bars, limits, delimiters, matrices and words in a formula', () => {
    expect(ommlNames(latexToOmml('\\hat{x}'))).toContain('acc');
    expect(ommlNames(latexToOmml('\\overline{x}'))).toContain('bar');
    expect(ommlNames(latexToOmml('\\lim_{x \\to 0} f'))).toContain('limLow');
    expect(ommlNames(latexToOmml('\\left( x + y \\right)'))).toContain('d');
    const matrix = parse(latexToOmml('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'));
    expect(matrix.getElementsByTagNameNS(M, 'm').length).toBe(1);
    expect(matrix.getElementsByTagNameNS(M, 'mr').length).toBe(2);
    expect(matrix.getElementsByTagNameNS(M, 'd').length, 'in its parentheses').toBe(1);
    const words = parse(latexToOmml('x \\text{ if } y'));
    expect([...words.getElementsByTagNameNS(M, 'nor')].length).toBe(1);
    const sine = parse(latexToOmml('\\sin x'));
    const upright = [...sine.getElementsByTagNameNS(M, 'r')].find((r) => r.textContent === 'sin')!;
    expect(upright.getElementsByTagNameNS(M, 'sty')[0].getAttributeNS(M, 'val'), 'a function name is upright').toBe('p');
  });

  it('keeps what would break the document out of it, and writes a formula that does not parse as its text', () => {
    const lt = latexToOmml('a < b \\& c');
    expect(() => parse(lt)).not.toThrow();
    expect(parse(lt).getElementsByTagName('parsererror').length).toBe(0);
    expect(textOf(lt)).toContain('<');
    const broken = latexToOmml('\\frac{a}{');
    expect(parse(broken).getElementsByTagName('parsererror').length).toBe(0);
    expect(textOf(broken)).toContain('\\frac{a}{');
  });
});

describe('a Word formula, drawn', () => {
  it('is MathML of the same shape', () => {
    expect(mathNames(roundTrip('\\frac{a}{b}'))).toEqual(expect.arrayContaining(['math', 'mfrac']));
    expect(mathNames(roundTrip('x_i^2'))).toContain('msubsup');
    expect(mathNames(roundTrip('\\sqrt{x}'))).toContain('msqrt');
    expect(mathNames(roundTrip('\\sqrt[3]{x}'))).toContain('mroot');
    expect(mathNames(roundTrip('\\sum_{i=1}^{n} x_i'))).toEqual(expect.arrayContaining(['munderover']));
    expect(mathNames(roundTrip('\\hat{x}'))).toContain('mover');
    expect(mathNames(roundTrip('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'))).toEqual(expect.arrayContaining(['mtable', 'mtr', 'mtd']));
    expect(roundTrip('E = mc^2', true).getAttribute('display')).toBe('block');
    expect(roundTrip('\\frac{a}{b}').namespaceURI).toBe(MML);
  });
});

describe('a Markdown note, made into a Word document', () => {
  const NOTE = '# Results\n\nThe mean $\\bar x = \\frac{1}{n}\\sum_i x_i$ is **robust** and *simple*, see [the source](https://example.org).\n\n$$\n\\int_0^1 f(t)\\,dt = 1\n$$\n\n- first point\n- second point\n\n1. step one\n2. step two\n\n> a quoted line\n\n```\ncode line\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';

  it('is a Word document another reader opens, with its words in order', async () => {
    const bytes = await markdownToDocx(NOTE);
    const { value } = await mammoth.extractRawText({ arrayBuffer: bytes.slice().buffer as ArrayBuffer });
    for (const words of ['Results', 'is robust and simple, see the source', 'first point', 'step two', 'a quoted line', 'code line']) expect(value).toContain(words);
  });

  it('has its headings, emphasis, lists, quote, code, table and link as Word has them, and its formulas as Word formulas', async () => {
    const zip = await JSZip.loadAsync(await markdownToDocx(NOTE));
    const xml = await zip.file('word/document.xml')!.async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const styles = [...doc.getElementsByTagNameNS(W, 'pStyle')].map((s) => s.getAttributeNS(W, 'val'));
    expect(styles).toEqual(expect.arrayContaining(['Heading1', 'Quote', 'Code']));
    expect(doc.getElementsByTagNameNS(W, 'b').length).toBeGreaterThan(0);
    expect(doc.getElementsByTagNameNS(W, 'i').length).toBeGreaterThan(0);
    expect(doc.getElementsByTagNameNS(W, 'numPr').length, 'the list items are numbered or bulleted by Word').toBe(4);
    expect(doc.getElementsByTagNameNS(W, 'tbl').length).toBe(1);
    expect(doc.getElementsByTagNameNS(W, 'hyperlink').length).toBe(1);
    // one formula in the line, inside its paragraph; one on its own
    expect(doc.getElementsByTagNameNS(M, 'oMathPara').length).toBe(1);
    expect(doc.getElementsByTagNameNS(M, 'oMath').length).toBe(2);
    const inline = doc.getElementsByTagNameNS(M, 'oMath')[0];
    expect(inline.parentElement!.localName).toBe('p');
    expect(inline.getElementsByTagNameNS(M, 'nary').length).toBe(1);
    // the parts a Word document has to have
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml']) expect(zip.file(part), part).not.toBeNull();
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(rels).toContain('https://example.org');
    expect(rels).toContain('TargetMode="External"');
    // set in the text face of the app
    expect(await zip.file('word/styles.xml')!.async('string')).toContain('Times New Roman');
  });

  it('is read back with its formulas as formulas', async () => {
    const read = await readDocx(await markdownToDocx(NOTE));
    expect(read.hasMath).toBe(true);
    const maths = read.blocks.flatMap((b) => b.parts).filter((p) => p.kind === 'math');
    expect(maths.map((m) => m.kind === 'math' && m.display)).toEqual([false, true]);
  });
});

describe('a Word document with formulas, in its reader', () => {
  let shell: FakeWorkspace;
  let view: Mounted | null = null;
  const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  const until = async (ok: () => unknown) => { for (let i = 0; i < 200 && !ok(); i++) await during(tick); };
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

  it('shows its formulas drawn where they stand, and a quote across one has the words as shown', async () => {
    shell.seed('papers/w.docx', '');
    shell.files.get(fileIdOf('papers/w.docx'))!.bytes = await markdownToDocx('Before $x^2 + 1$ after.\n\n$$\ny = mx\n$$\n');
    const quoted: { words: string; ref: unknown }[] = [];
    view = await mount(<div style={{ height: 600, display: 'flex' }}><ResourceReader resourceRef={{ fileId: fileIdOf('papers/w.docx'), selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }} name="w.docx" onQuote={(ref, words) => quoted.push({ ref, words })} /></div>);
    await until(() => view!.container.querySelector('[data-reader-text] math'));
    const shown = view.container.querySelector<HTMLElement>('[data-reader-text]')!;
    const maths = [...shown.getElementsByTagNameNS(MML, 'math')];
    expect(maths.length).toBe(2);
    expect(maths[1].getAttribute('display')).toBe('block');
    expect(maths[0].getElementsByTagNameNS(MML, 'msup').length).toBe(1);
    // a selection from before the formula to after it
    const first = shown.firstChild as Text;
    const after = [...shown.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.includes('after'))! as Text;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(after, after.textContent!.indexOf('after') + 'after'.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    await during(() => view!.container.querySelector<HTMLElement>('[data-reader-quote]')!.click());
    expect(quoted.length).toBe(1);
    expect(quoted[0].words).toBe(range.toString());
    expect(quoted[0].words.startsWith('Before ')).toBe(true);
    expect(quoted[0].words.endsWith(' after')).toBe(true);
  });

  it('a Word document with no formula is read as before', async () => {
    shell.seed('papers/plain.docx', '');
    shell.files.get(fileIdOf('papers/plain.docx'))!.bytes = await markdownToDocx('Only words here.\n');
    view = await mount(<div style={{ height: 600, display: 'flex' }}><ResourceReader resourceRef={{ fileId: fileIdOf('papers/plain.docx'), selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }} name="plain.docx" /></div>);
    await until(() => view!.container.querySelector('[data-reader-text]'));
    expect(view.container.querySelector('[data-reader-text]')!.textContent).toContain('Only words here.');
    expect(view.container.querySelector('[data-reader-text] math')).toBeNull();
  });

  it('a Markdown note is made into a Word document beside it, from what is typed, and the document opens to read on the right', async () => {
    shell.seed('notes/n.md', '# Note\n\nArea $\\pi r^2$.\n');
    const doc = await documents.open(fileIdOf('notes/n.md'), 'view-1');
    view = await mount(<div style={{ height: 600, display: 'flex' }}><MarkdownEditor documentId={doc.documentId} surfaceId="view-1" onSave={() => {}} /></div>);
    await during(() => { documents.setText(doc.documentId, '# Note\n\nArea $\\pi r^2$ and more.\n', 'view-1'); });
    await during(() => view!.container.querySelector<HTMLElement>('[data-markdown-export="docx"]')!.click());
    await until(() => useSurfaces.getState().surfaces.length > 0);
    const order = shell.calls.map((c) => c.method).filter((m) => m === 'saveText' || m === 'exportBeside');
    expect(order, 'what is typed is saved first').toEqual(['saveText', 'exportBeside']);
    const made = [...shell.files.values()].find((f) => f.relativePath === 'notes/n.docx')!;
    expect(made).toBeDefined();
    const { value } = await mammoth.extractRawText({ arrayBuffer: made.bytes!.slice().buffer as ArrayBuffer });
    expect(value).toContain('and more.');
    const zip = await JSZip.loadAsync(made.bytes!);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('m:oMath');
    expect(useSurfaces.getState().surfaces.map((s) => [s.fileId, s.reading, s.placement])).toEqual([[made.fileId, true, 'right']]);
  });
});
