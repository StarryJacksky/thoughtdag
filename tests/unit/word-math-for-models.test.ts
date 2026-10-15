import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { latexToOmml } from '../../src/lib/docx/omml';
import { markdownToDocx } from '../../src/lib/docx/write';
import { readFileToAttachment } from '../../src/lib/attachments';
import { buildContext } from '../../src/store/context-builder';

// A Word document's formulas, as the model reads them: a Word document put
// on the canvas as material (or attached to a question) is read as its
// words with its formulas written in LaTeX, $…$ in the line and $$…$$ on
// lines of their own, so a model that is asked about it sees the
// mathematics and not a gap where it stood.

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

/** A LaTeX formula through Word (OMML) and back to LaTeX. */
async function throughWord(tex: string): Promise<string> {
  const { ommlToLatex } = await import('../../src/lib/docx/latex');
  const doc = new DOMParser().parseFromString(`<root xmlns:m="${M}">${latexToOmml(tex)}</root>`, 'application/xml');
  return ommlToLatex(doc.getElementsByTagNameNS(M, 'oMath')[0]);
}
/** What KaTeX draws for a formula, in words: two formulas that read the same draw the same. */
const drawn = (tex: string) => new DOMParser().parseFromString(katex.renderToString(tex, { output: 'mathml', throwOnError: true }), 'text/html').getElementsByTagName('semantics')[0].firstElementChild!.textContent;

describe('a Word formula, written for a model', () => {
  it('is LaTeX that draws what the formula draws', async () => {
    for (const tex of [
      '\\frac{a}{b}', 'x^2', 'x_i', 'x_i^2', '\\sqrt{x}', '\\sqrt[3]{x}', '\\sum_{i=1}^{n} x_i', '\\int_0^1 f(t)\\,dt',
      '\\hat{x}', '\\overline{x}', '\\lim_{x \\to 0} \\frac{\\sin x}{x}', '\\left( x + y \\right)', '\\alpha + \\beta \\leq \\gamma',
      '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}', 'f(x) = \\text{if } x',
    ]) {
      const back = await throughWord(tex);
      expect(() => katex.renderToString(back, { throwOnError: true }), `${tex} → ${back}`).not.toThrow();
      expect(drawn(back), `${tex} → ${back}`).toBe(drawn(tex));
    }
  });

  it('writes the structures by their LaTeX names', async () => {
    expect(await throughWord('\\frac{a}{b}')).toBe('\\frac{a}{b}');
    expect(await throughWord('\\sum_{i=1}^{n} x_i')).toBe('\\sum_{i=1}^{n}{x_{i}}');
    expect(await throughWord('\\sqrt[3]{x}')).toBe('\\sqrt[3]{x}');
    expect(await throughWord('\\sin x')).toBe('\\sin x');
  });
});

describe('a Word document with formulas, as material', () => {
  const NOTE = 'The mean $\\bar x = \\frac{1}{n}\\sum_i x_i$ is robust.\n\n$$\n\\int_0^1 f(t)\\,dt = 1\n$$\n\nThe end.\n';
  const asFile = async (markdown: string, name = 'paper.docx') => new File([await markdownToDocx(markdown) as BlobPart], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

  it('is read with its formulas in LaTeX, in the line and on lines of their own', async () => {
    const att = await readFileToAttachment(await asFile(NOTE));
    expect(att).not.toBeNull();
    const text = att!.content;
    expect(text).toContain('The mean $');
    expect(text).toMatch(/\$[^$]*\\frac\{1\}\{n\}[^$]*\$ is robust\./);
    expect(text).toMatch(/\n\$\$\n[^$]*\\int_\{0\}\^\{1\}[^$]*\n\$\$\n/);
    expect(text).toContain('The end.');
  });

  it('reaches a question it is wired to with its formulas', async () => {
    const att = (await readFileToAttachment(await asFile(NOTE)))!;
    const node = (id: string, data: Record<string, unknown>) => ({ id, type: 'thought' as const, position: { x: 0, y: 0 }, data: { question: '', response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'tag' as const, attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit' as const, isRoot: false, isBranch: false, ...data } });
    const material = node('m', { stepKind: 'file', attachments: [att] });
    const ask = node('q', { question: 'What does the integral say?' });
    const context = buildContext('q', [material, ask], [{ id: 'e', source: 'm', target: 'q' }]).messages.map((m) => m.content).join('\n');
    expect(context).toContain('\\frac{1}{n}');
    expect(context).toContain('\\int_{0}^{1}');
  });

  it('a Word document with no formula is read as before', async () => {
    const att = await readFileToAttachment(await asFile('Only words here.\n'));
    expect(att!.content).toBe('Only words here.');
  });
});
