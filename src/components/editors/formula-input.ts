import { EditorSelection, StateField, type EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import katex from 'katex';
import { findMath, focused, followFocus, type MathRange } from './live-preview';

// Typing formulas quickly, in Markdown and in a LaTeX source:
//   - the commands of LaTeX are offered as they are typed (`\fr` gives
//     `\frac{}{}` with the cursor in the first place to fill, Tab to the
//     next): in Markdown inside a formula only, in a LaTeX source anywhere;
//   - a dollar sign comes with the one that closes it, and typing it again
//     steps over that one; typed over a selection, it makes the selection a
//     formula. A brace does the same inside a formula (anywhere in LaTeX);
//   - Mod-E puts a formula in the line, Mod-Shift-E one on lines of its own
//     (`$$` in Markdown, `\[ \]` in LaTeX), around what is selected if
//     anything is. (Not Mod-M: on macOS that key minimizes the window.)
//   - while the cursor is in a formula, the formula is shown drawn under it.
// Nothing here writes anything but what was typed; the drawing is KaTeX
// with nothing that could act (`trust` off), and a formula that does not
// parse yet is shown as it is, marked.

export type FormulaKind = 'markdown' | 'tex';

// ── where the formulas are ─────────────────────────────────────────────

/** How far either way of a position formulas are looked for: a formula is a few lines at most. */
const AROUND = 40;

/** The formula the position is inside (between its delimiters), or null. Only the lines around it are read. */
export function formulaAt(state: EditorState, pos: number, kind: FormulaKind): MathRange | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const from = doc.line(Math.max(1, line.number - AROUND)).from;
  const to = doc.line(Math.min(doc.lines, line.number + AROUND)).to;
  const text = doc.sliceString(from, to);
  const code: [number, number][] = [];
  if (kind === 'markdown') {
    syntaxTree(state).iterate({ from, to, enter: (node) => { if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') code.push([node.from - from, node.to - from]); } });
  }
  const found = findMath(text, kind, (a, b) => code.some(([c, d]) => a < d && b > c));
  const hit = found.find((m) => m.from + from < pos && pos < m.to + from);
  return hit ? { ...hit, from: hit.from + from, to: hit.to + from } : null;
}

const inFormula = (state: EditorState, pos: number, kind: FormulaKind) => formulaAt(state, pos, kind) !== null;

// ── the commands offered ───────────────────────────────────────────────

/** A command written as it is, drawn as `glyph`. */
const plain = (name: string, glyph: string): Completion => ({ label: `\\${name}`, detail: glyph, type: 'constant' });
/** A command with places to fill, `${}` each (see @codemirror/autocomplete's snippets). */
const shaped = (label: string, template: string, detail: string): Completion => snippetCompletion(template, { label, detail, type: 'function' });

const GREEK: [string, string][] = [
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ϵ'], ['varepsilon', 'ε'], ['zeta', 'ζ'], ['eta', 'η'],
  ['theta', 'θ'], ['vartheta', 'ϑ'], ['iota', 'ι'], ['kappa', 'κ'], ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['pi', 'π'],
  ['rho', 'ρ'], ['sigma', 'σ'], ['tau', 'τ'], ['upsilon', 'υ'], ['phi', 'ϕ'], ['varphi', 'φ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'],
  ['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'], ['Pi', 'Π'], ['Sigma', 'Σ'], ['Upsilon', 'Υ'], ['Phi', 'Φ'], ['Psi', 'Ψ'], ['Omega', 'Ω'],
];
const SYMBOLS: [string, string][] = [
  ['sum', '∑'], ['prod', '∏'], ['int', '∫'], ['iint', '∬'], ['oint', '∮'], ['infty', '∞'], ['partial', '∂'], ['nabla', '∇'],
  ['cdot', '·'], ['times', '×'], ['div', '÷'], ['pm', '±'], ['mp', '∓'], ['leq', '≤'], ['geq', '≥'], ['neq', '≠'], ['approx', '≈'],
  ['equiv', '≡'], ['sim', '∼'], ['propto', '∝'], ['in', '∈'], ['notin', '∉'], ['subset', '⊂'], ['subseteq', '⊆'], ['supset', '⊃'],
  ['cup', '∪'], ['cap', '∩'], ['emptyset', '∅'], ['forall', '∀'], ['exists', '∃'], ['neg', '¬'], ['land', '∧'], ['lor', '∨'],
  ['to', '→'], ['rightarrow', '→'], ['leftarrow', '←'], ['Rightarrow', '⇒'], ['Leftarrow', '⇐'], ['Leftrightarrow', '⇔'], ['mapsto', '↦'],
  ['ldots', '…'], ['cdots', '⋯'], ['vdots', '⋮'], ['ddots', '⋱'], ['quad', '␣'], ['qquad', '␣␣'], ['ell', 'ℓ'], ['hbar', 'ℏ'],
  ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'], ['log', 'log'], ['ln', 'ln'], ['exp', 'exp'], ['max', 'max'], ['min', 'min'], ['det', 'det'],
  ['lim', 'lim'], ['sup', 'sup'], ['inf', 'inf'], ['arg', 'arg'],
];
const STRUCTURES: Completion[] = [
  shaped('\\frac', '\\frac{${}}{${}}', 'a/b'),
  shaped('\\dfrac', '\\dfrac{${}}{${}}', 'a/b'),
  shaped('\\sqrt', '\\sqrt{${}}', '√x'),
  shaped('\\sqrt[]{}', '\\sqrt[${}]{${}}', 'ⁿ√x'),
  shaped('\\sum_{}^{}', '\\sum_{${}}^{${}}', '∑ᵢⁿ'),
  shaped('\\prod_{}^{}', '\\prod_{${}}^{${}}', '∏ᵢⁿ'),
  shaped('\\int_{}^{}', '\\int_{${}}^{${}}', '∫ₐᵇ'),
  shaped('\\lim_{}', '\\lim_{${} \\to ${}}', 'lim'),
  shaped('\\binom', '\\binom{${}}{${}}', '(n k)'),
  shaped('\\overline', '\\overline{${}}', 'x̄'),
  shaped('\\underline', '\\underline{${}}', 'x̲'),
  shaped('\\hat', '\\hat{${}}', 'x̂'),
  shaped('\\bar', '\\bar{${}}', 'x̄'),
  shaped('\\vec', '\\vec{${}}', 'x⃗'),
  shaped('\\tilde', '\\tilde{${}}', 'x̃'),
  shaped('\\dot', '\\dot{${}}', 'ẋ'),
  shaped('\\ddot', '\\ddot{${}}', 'ẍ'),
  shaped('\\mathbf', '\\mathbf{${}}', '𝐱'),
  shaped('\\mathrm', '\\mathrm{${}}', 'x'),
  shaped('\\mathbb', '\\mathbb{${}}', 'ℝ'),
  shaped('\\mathcal', '\\mathcal{${}}', '𝒳'),
  shaped('\\text', '\\text{${}}', 'abc'),
  shaped('\\operatorname', '\\operatorname{${}}', 'op'),
  shaped('\\left( \\right)', '\\left( ${} \\right)', '( )'),
  shaped('\\left[ \\right]', '\\left[ ${} \\right]', '[ ]'),
  shaped('\\begin{pmatrix}', '\\begin{pmatrix}\n${} & ${} \\\\\\\\\n${} & ${}\n\\end{pmatrix}', '( ⋱ )'),
  shaped('\\begin{bmatrix}', '\\begin{bmatrix}\n${} & ${} \\\\\\\\\n${} & ${}\n\\end{bmatrix}', '[ ⋱ ]'),
  shaped('\\begin{cases}', '\\begin{cases}\n${} & ${} \\\\\\\\\n${} & ${}\n\\end{cases}', '{ cases'),
  shaped('\\begin{aligned}', '\\begin{aligned}\n${} &= ${} \\\\\\\\\n&= ${}\n\\end{aligned}', 'a = b'),
];
/** What a formula is written with. */
const MATH: Completion[] = [...GREEK.map(([n, g]) => plain(n, g)), ...SYMBOLS.map(([n, g]) => plain(n, g)), ...STRUCTURES];
/** What a LaTeX source is written with outside its formulas. */
const DOCUMENT: Completion[] = [
  shaped('\\section{}', '\\section{${}}', '§'),
  shaped('\\subsection{}', '\\subsection{${}}', '§§'),
  shaped('\\subsubsection{}', '\\subsubsection{${}}', '§§§'),
  shaped('\\paragraph{}', '\\paragraph{${}}', '¶'),
  shaped('\\textbf{}', '\\textbf{${}}', 'bold'),
  shaped('\\textit{}', '\\textit{${}}', 'italic'),
  shaped('\\emph{}', '\\emph{${}}', 'emphasis'),
  shaped('\\cite{}', '\\cite{${}}', '[1]'),
  shaped('\\ref{}', '\\ref{${}}', 'ref'),
  shaped('\\label{}', '\\label{${}}', 'label'),
  shaped('\\usepackage{}', '\\usepackage{${}}', 'package'),
  shaped('\\begin{equation}', '\\begin{equation}\n${}\n\\end{equation}', 'equation'),
  shaped('\\begin{align}', '\\begin{align}\n${} &= ${}\n\\end{align}', 'align'),
  shaped('\\begin{itemize}', '\\begin{itemize}\n\\item ${}\n\\end{itemize}', '•'),
  shaped('\\begin{enumerate}', '\\begin{enumerate}\n\\item ${}\n\\end{enumerate}', '1.'),
  shaped('\\begin{figure}', '\\begin{figure}[h]\n\\centering\n${}\n\\caption{${}}\n\\end{figure}', 'figure'),
  shaped('\\begin{table}', '\\begin{table}[h]\n\\centering\n${}\n\\caption{${}}\n\\end{table}', 'table'),
  plain('item', '•'),
];

/** The commands that can be typed where the cursor is. */
function commands(kind: FormulaKind) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/\\[A-Za-z]*(\{[A-Za-z*]*)?$/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    if (kind === 'markdown' && !inFormula(context.state, context.pos, kind)) return null;
    const options = kind === 'tex' ? [...MATH, ...DOCUMENT] : MATH;
    return { from: word.from, options, validFor: /^\\[A-Za-z]*(\{[A-Za-z*]*)?$/ };
  };
}

// ── dollar signs and braces ────────────────────────────────────────────

/**
 * What typing `text` over `from`..`to` does, if it is one of the characters
 * a formula pairs: the change to make, or null for the ordinary one.
 */
export function pairedTyping(state: EditorState, from: number, to: number, text: string, kind: FormulaKind): TransactionSpec | null {
  const before = state.sliceDoc(Math.max(0, from - 1), from);
  const after = state.sliceDoc(to, to + 1);
  if (text === '$') {
    // over a selection: the selection becomes a formula
    if (from !== to) return { changes: [{ from, insert: '$' }, { from: to, insert: '$' }], selection: EditorSelection.range(from + 1, to + 1), userEvent: 'input.type' };
    // the end of the formula the cursor is in: step over its closing sign
    if (after === '$' && inFormula(state, from, kind)) return { selection: { anchor: from + 1 }, userEvent: 'select' };
    // an escaped dollar, or one written straight after a word (US$): a dollar, nothing more
    if (before === '\\' || /[\p{L}\p{N}]/u.test(before)) return null;
    return { changes: { from, insert: '$$' }, selection: { anchor: from + 1 }, userEvent: 'input.type' };
  }
  const bracing = kind === 'tex' || inFormula(state, from, kind);
  if (text === '{' && bracing && from === to && !/[\p{L}\p{N}]/u.test(after)) {
    return { changes: { from, insert: '{}' }, selection: { anchor: from + 1 }, userEvent: 'input.type' };
  }
  if (text === '}' && bracing && from === to && after === '}') return { selection: { anchor: from + 1 }, userEvent: 'select' };
  return null;
}

const pairing = (kind: FormulaKind) => EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || view.state.readOnly) return false;
  const spec = pairedTyping(view.state, from, to, text, kind);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
});

// ── the keys ───────────────────────────────────────────────────────────

/** Put a formula in the line: `$…$` around the selection, or an empty one with the cursor in it. */
function inlineFormula(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  view.dispatch({
    ...view.state.changeByRange((range) => ({
      changes: [{ from: range.from, insert: '$' }, { from: range.to, insert: '$' }],
      range: range.empty ? EditorSelection.cursor(range.from + 1) : EditorSelection.range(range.from + 1, range.to + 1),
    })),
    userEvent: 'input',
  });
  return true;
}

/** Put a formula on lines of its own, the selection in it, the cursor on its middle line. */
function blockFormula(kind: FormulaKind) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    const [open, close] = kind === 'tex' ? ['\\[', '\\]'] : ['$$', '$$'];
    const { state } = view;
    view.dispatch({ ...state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const endLine = state.doc.lineAt(range.to);
      const lead = range.from > line.from && state.sliceDoc(line.from, range.from).trim() ? '\n' : '';
      const trail = range.to < endLine.to || range.to === state.doc.length ? '\n' : '';
      const inner = state.sliceDoc(range.from, range.to);
      const insert = `${lead}${open}\n${inner}\n${close}${trail}`;
      const at = range.from + lead.length + open.length + 1;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(at + inner.length) };
    }), userEvent: 'input' });
    return true;
  };
}

// ── the formula being typed, drawn under it ────────────────────────────

function previewOf(state: EditorState, kind: FormulaKind): Tooltip | null {
  const sel = state.selection.main;
  if (!sel.empty || !state.field(focused, false)) return null;
  const formula = formulaAt(state, sel.head, kind);
  if (!formula || !formula.tex.trim()) return null;
  return {
    pos: formula.from,
    above: false,
    arrow: false,
    create: () => {
      // the editor makes the outer element its tooltip; the drawing is inside it
      const dom = document.createElement('div');
      dom.className = 'cm-formula-tooltip';
      const drawn = dom.appendChild(document.createElement('div'));
      drawn.className = 'cm-formula-preview';
      drawn.dataset.formulaPreview = formula.display ? 'display' : 'inline';
      try {
        katex.render(formula.tex, drawn, { displayMode: formula.display, throwOnError: false, trust: false, strict: 'ignore' });
      } catch {
        drawn.textContent = formula.tex; // not even KaTeX's own error could be drawn: the source, as it is
        drawn.classList.add('cm-formula-preview-error');
      }
      return { dom };
    },
  };
}

function preview(kind: FormulaKind) {
  return StateField.define<Tooltip | null>({
    create: (state) => previewOf(state, kind),
    update: (tip, tr) => {
      if (!tr.docChanged && !tr.selection && !tr.effects.length) return tip;
      const next = previewOf(tr.state, kind);
      // the same formula, unchanged: the tooltip that is there stays
      if (tip && next && !tr.docChanged && tip.pos === next.pos) return tip;
      return next;
    },
    provide: (field) => showTooltip.from(field),
  });
}

/** Everything above, for a Markdown file or a LaTeX source. */
export function formulaInput(kind: FormulaKind): Extension {
  return [
    focused,
    followFocus,
    autocompletion({ override: [commands(kind)], icons: false }),
    pairing(kind),
    keymap.of([
      { key: 'Mod-e', preventDefault: true, run: inlineFormula },
      { key: 'Mod-Shift-e', preventDefault: true, run: blockFormula(kind) },
    ]),
    preview(kind),
  ];
}
