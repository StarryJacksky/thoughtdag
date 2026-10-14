// What a Markdown or LaTeX source looks like while it is typed: laid out
// as it reads, on the text itself. Headings large, bold bold, a link as its
// words, a formula as the formula; the markup shows only where the cursor
// is, so it can be edited. Nothing here changes the text: the editor shows
// decorations over it, and what is saved is exactly what was typed.
//
// For LaTeX only the formulas are drawn: the rest of a source is its
// commands, and those are what a person edits.
//
// Formulas are drawn by KaTeX with nothing that could act: no links, no
// HTML of the file's own (`trust` is off), and a formula that does not
// parse is shown as it is, marked, never as an error that stops the page.

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export interface MathRange {
  /** where the formula is in the text, delimiters included */
  from: number;
  to: number;
  /** what is handed to KaTeX: the formula without its delimiters (an environment is handed whole) */
  tex: string;
  /** shown on its own, as a display */
  display: boolean;
}

/** The LaTeX environments that are display math, drawn whole. */
const DISPLAY_ENVIRONMENTS = ['equation', 'align', 'gather', 'multline', 'flalign', 'alignat', 'displaymath', 'eqnarray'];

/**
 * The formulas in a text. In Markdown: `$…$` and `\(…\)` inline, `$$…$$`
 * and `\[…\]` on their own. A dollar is not a formula when it is escaped,
 * when the opening one is followed by a space, or when the closing one
 * comes after a space or before a digit (that is how money is told from
 * mathematics). In LaTeX also the display environments, and nothing after
 * an unescaped `%` on a line. `skip(from, to)` says where formulas are not
 * looked for (code, in Markdown).
 */
export function findMath(text: string, kind: 'markdown' | 'tex', skip: (from: number, to: number) => boolean = () => false): MathRange[] {
  const found: MathRange[] = [];
  const add = (from: number, to: number, tex: string, display: boolean) => {
    if (tex.trim() && !skip(from, to)) found.push({ from, to, tex, display });
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const next = text[i + 1];
      if (next === '(' || next === '[') {
        const close = next === '(' ? '\\)' : '\\]';
        const end = text.indexOf(close, i + 2);
        if (end >= 0 && (next === '[' || !text.slice(i + 2, end).includes('\n\n'))) { add(i, end + 2, text.slice(i + 2, end), next === '['); i = end + 2; continue; }
      }
      if (kind === 'tex' && text.startsWith('\\begin{', i)) {
        const name = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(text.slice(i, i + 40))?.[1];
        if (name && DISPLAY_ENVIRONMENTS.includes(name.replace(/\*$/, ''))) {
          const closing = `\\end{${name}}`;
          const end = text.indexOf(closing, i);
          if (end >= 0) { add(i, end + closing.length, text.slice(i, end + closing.length), true); i = end + closing.length; continue; }
        }
      }
      i += 2; // an escaped character, or a command: never the start of a formula
      continue;
    }
    if (kind === 'tex' && c === '%') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === '$') {
      if (text[i + 1] === '$') {
        const end = text.indexOf('$$', i + 2);
        if (end >= 0) { add(i, end + 2, text.slice(i + 2, end), true); i = end + 2; continue; }
        i += 2;
        continue;
      }
      // inline: not opened by a space, closed on the same line by a dollar that is not after a space nor before a digit
      if (text[i + 1] && !/\s/.test(text[i + 1])) {
        let end = i + 1;
        let closed = -1;
        while (end < text.length && text[end] !== '\n') {
          if (text[end] === '\\') { end += 2; continue; }
          if (text[end] === '$') {
            if (!/\s/.test(text[end - 1]) && !/[0-9]/.test(text[end + 1] ?? '')) closed = end;
            break;
          }
          end++;
        }
        if (closed > i + 1) { add(i, closed + 1, text.slice(i + 1, closed), false); i = closed + 1; continue; }
      }
    }
    i++;
  }
  return found;
}

/** A formula drawn in place of its source. Pressing on it puts the cursor in it: the source shows, to be edited. */
class MathWidget extends WidgetType {
  readonly tex: string;
  readonly display: boolean;
  readonly from: number;
  constructor(tex: string, display: boolean, from: number) { super(); this.tex = tex; this.display = display; this.from = from; }
  eq(other: MathWidget): boolean { return other.tex === this.tex && other.display === this.display && other.from === this.from; }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = `cm-math ${this.display ? 'cm-math-block' : 'cm-math-inline'}`;
    el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' });
    el.addEventListener('mousedown', (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 1 } });
      view.focus();
    });
    return el;
  }
  ignoreEvent(): boolean { return false; }
}

/** A list item's marker, drawn as a bullet. */
class BulletWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-md-bullet';
    el.textContent = '•';
    return el;
  }
}

// The markup shows where the cursor is only while the editor is being typed in: a document that is just
// open, or that the person is reading while working elsewhere, is shown laid out from top to bottom.
const focusChanged = StateEffect.define<boolean>();
const focused = StateField.define<boolean>({
  create: () => false,
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(focusChanged) ? e.value : v), value),
});
const followFocus = EditorView.focusChangeEffect.of((_state, focusing) => focusChanged.of(focusing));

const hidden = Decoration.replace({});
const lineClass = (name: string) => Decoration.line({ class: name });
const mark = (name: string) => Decoration.mark({ class: name });

/** Whether the selection, or the cursor, is in or at the edge of this stretch of text, while the person is typing here. */
const touched = (state: EditorState, from: number, to: number) => state.field(focused, false) === true && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
/** Whether the selection, or the cursor, is on one of the lines this stretch is on, while the person is typing here. */
const onItsLines = (state: EditorState, from: number, to: number) => {
  if (state.field(focused, false) !== true) return false;
  const [first, last] = [state.doc.lineAt(from).number, state.doc.lineAt(to).number];
  return state.selection.ranges.some((r) => state.doc.lineAt(r.head).number >= first && state.doc.lineAt(r.head).number <= last);
};

/** The parsed tree, waiting a moment for it to be whole: what is decorated is what is parsed. */
const treeOf = (state: EditorState) => ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);

function decorate(state: EditorState, kind: 'markdown' | 'tex'): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const text = state.doc.toString();
  const code: [number, number][] = [];
  const tree = kind === 'markdown' ? treeOf(state) : null;
  if (tree) {
    tree.iterate({ enter: (node) => { if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') code.push([node.from, node.to]); } });
  }
  const formulas = findMath(text, kind, (from, to) => code.some(([a, b]) => from < b && to > a));
  const inFormula = (from: number, to: number) => formulas.some((m) => from < m.to && to > m.from);

  for (const formula of formulas) {
    if (touched(state, formula.from, formula.to)) continue;
    ranges.push(Decoration.replace({ widget: new MathWidget(formula.tex, formula.display, formula.from), block: false }).range(formula.from, formula.to));
  }

  if (tree) {
    tree.iterate({
      enter: (node) => {
        const { name, from, to } = node;
        if (inFormula(from, to) && name !== 'Paragraph' && name !== 'Document') return;
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          ranges.push(lineClass(`cm-md-h${heading[1]}`).range(state.doc.lineAt(from).from));
          const marker = node.node.getChild('HeaderMark');
          if (marker && !onItsLines(state, from, to)) {
            const space = text[marker.to] === ' ' ? 1 : 0;
            ranges.push(hidden.range(marker.from, marker.to + space));
          }
          return;
        }
        switch (name) {
          case 'StrongEmphasis': case 'Emphasis': case 'Strikethrough': case 'InlineCode': {
            const cls = name === 'StrongEmphasis' ? 'cm-md-strong' : name === 'Emphasis' ? 'cm-md-em' : name === 'Strikethrough' ? 'cm-md-strike' : 'cm-md-code';
            const marks = node.node.getChildren(name === 'InlineCode' ? 'CodeMark' : name === 'Strikethrough' ? 'StrikethroughMark' : 'EmphasisMark');
            const inner = marks.length >= 2 ? [marks[0].to, marks[marks.length - 1].from] : [from, to];
            if (inner[1] > inner[0]) ranges.push(mark(cls).range(inner[0], inner[1]));
            if (!touched(state, from, to)) for (const m of marks) ranges.push(hidden.range(m.from, m.to));
            return name === 'InlineCode' ? false : undefined;
          }
          case 'Link': {
            const marks = node.node.getChildren('LinkMark');
            if (marks.length >= 2) {
              ranges.push(mark('cm-md-link').range(marks[0].to, marks[1].from));
              if (!touched(state, from, to)) {
                ranges.push(hidden.range(marks[0].from, marks[0].to));
                ranges.push(hidden.range(marks[1].from, to));
              }
            }
            return false;
          }
          case 'Blockquote': {
            for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++) ranges.push(lineClass('cm-md-quote').range(state.doc.line(line).from));
            if (!onItsLines(state, from, to)) {
              for (const quote of node.node.getChildren('QuoteMark')) ranges.push(hidden.range(quote.from, text[quote.to] === ' ' ? quote.to + 1 : quote.to));
              // the marks of the paragraphs inside
              node.node.cursor().iterate((inner) => { if (inner.name === 'QuoteMark' && inner.from > from) ranges.push(hidden.range(inner.from, text[inner.to] === ' ' ? inner.to + 1 : inner.to)); });
            }
            return;
          }
          case 'ListMark': {
            const item = node.node.parent;
            const bullet = item?.parent?.name === 'BulletList';
            if (bullet && !onItsLines(state, from, to)) ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
            return;
          }
          case 'FencedCode': case 'CodeBlock': {
            for (let line = state.doc.lineAt(from).number; line <= state.doc.lineAt(to).number; line++) ranges.push(lineClass('cm-md-codeblock').range(state.doc.line(line).from));
            return false;
          }
          case 'HorizontalRule':
            ranges.push(lineClass('cm-md-hr').range(state.doc.lineAt(from).from));
            if (!onItsLines(state, from, to)) ranges.push(mark('cm-md-hr-text').range(from, to));
            return;
          default:
            return;
        }
      },
    });
  }
  // marks inside a hidden stretch, or two hidden stretches over each other, are let go: the set must not cross itself
  return Decoration.set(dropCrossing(ranges), true);
}

/** Replacements must not cross one another: of two that do, the one that starts first (a formula, usually the wider) stays. */
function dropCrossing(ranges: Range<Decoration>[]): Range<Decoration>[] {
  const replacing = ranges.filter((r) => (r.value.spec as { widget?: unknown }).widget !== undefined || r.value === hidden).sort((a, b) => a.from - b.from || b.to - a.to);
  const kept: Range<Decoration>[] = [];
  let reach = -1;
  for (const r of replacing) {
    if (r.from < reach) continue;
    kept.push(r);
    reach = Math.max(reach, r.to);
  }
  const keptSet = new Set(kept);
  const covered = (r: Range<Decoration>) => kept.some((k) => k !== r && r.from >= k.from && r.to <= k.to && r.from !== r.to);
  return ranges.filter((r) => (replacing.includes(r) ? keptSet.has(r) : !(r.from !== r.to && covered(r))));
}

/** The decorations of a source, kept up to date with its text, its parse and the cursor. */
function previewField(kind: 'markdown' | 'tex') {
  return StateField.define<DecorationSet>({
    create: (state) => decorate(state, kind),
    update: (decorations, tr: Transaction) => {
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(focusChanged)) || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return decorate(tr.state, kind);
      return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** Markdown laid out as it reads, formulas drawn, markup showing where the cursor is. */
export const markdownLivePreview = (): Extension => [focused, followFocus, previewField('markdown')];
/** The formulas of a LaTeX source drawn where the cursor is not. */
export const texMathPreview = (): Extension => [focused, followFocus, previewField('tex')];
