// Word's formulas (OMML) written as LaTeX: what a model is given when a
// Word document is material. A fraction is \frac, a sum \sum with its
// limits, a matrix a matrix, a function name \sin; the letters and symbols
// stay the characters they are (Greek letters, operators), which a model
// and KaTeX both read. What is not known is written as its text.

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

const child = (el: Element | null | undefined, name: string): Element | null => (el ? [...el.children].find((c) => c.namespaceURI === M && c.localName === name) ?? null : null);
const prop = (props: Element | null, name: string): string | null => {
  const p = child(props, name);
  if (!p) return null;
  return p.getAttributeNS(M, 'val') ?? p.getAttribute('m:val') ?? '';
};
const on = (props: Element | null, name: string) => { const v = prop(props, name); return v !== null && v !== '0' && v !== 'off' && v !== 'false'; };

/** Function names LaTeX has a command for. */
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'sup', 'inf', 'lim', 'det', 'arg', 'dim', 'ker', 'gcd', 'deg', 'hom', 'Pr', 'liminf', 'limsup']);
const NARY: Record<string, string> = { '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint', '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge', '⨁': '\\bigoplus', '⨂': '\\bigotimes', '⨀': '\\bigodot' };
const ACCENTS: Record<string, string> = { '̂': '\\hat', '^': '\\hat', '̃': '\\tilde', '~': '\\tilde', '̇': '\\dot', '̈': '\\ddot', '⃗': '\\vec', '̅': '\\bar', '̄': '\\bar', '¯': '\\bar', '̆': '\\breve', '̌': '\\check', '́': '\\acute', '̀': '\\grave' };
/** A delimiter as LaTeX writes it after \left or \right. */
const fence = (chr: string): string => ({ '': '.', '{': '\\{', '}': '\\}', '‖': '\\|', '⟨': '\\langle', '⟩': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil' } as Record<string, string>)[chr] ?? chr;
/** Characters that mean something to LaTeX, written so that they are the characters. */
const literal = (text: string) => text.replace(/[\\{}#%&$_^~]/g, (c) => ({ '\\': '\\backslash ', '{': '\\{', '}': '\\}', '#': '\\#', '%': '\\%', '&': '\\&', $: '\\$', _: '\\_', '^': '\\^{}', '~': '\\sim ' } as Record<string, string>)[c]);

/** Join pieces, with a space where a command name would otherwise run into a letter. */
function join(pieces: string[]): string {
  let out = '';
  for (const p of pieces) {
    if (!p) continue;
    if (/\\[A-Za-z]+$/.test(out) && /^[A-Za-z]/.test(p)) out += ' ';
    out += p;
  }
  return out;
}

function run(r: Element): string {
  const text = [...r.getElementsByTagNameNS(M, 't')].map((t) => t.textContent ?? '').join('');
  const props = child(r, 'rPr');
  if (props && child(props, 'nor')) return `\\text{${text.replace(/[{}\\]/g, (c) => `\\${c === '\\' ? 'backslash ' : c}`)}}`;
  if (prop(props, 'sty') === 'p' && /^[A-Za-z]{2,}$/.test(text)) return FUNCTIONS.has(text) ? `\\${text}` : `\\operatorname{${text}}`;
  return literal(text).replace(/⁡/g, '');
}

function args(el: Element | null): string {
  return el ? join([...el.children].map(convert)) : '';
}
const braced = (el: Element | null) => `{${args(el)}}`;

function convert(el: Element): string {
  if (el.namespaceURI !== M) {
    const text = [...el.getElementsByTagNameNS('*', 't')].map((t) => t.textContent ?? '').join('');
    return text ? `\\text{${text}}` : '';
  }
  const pr = child(el, `${el.localName}Pr`);
  switch (el.localName) {
    case 'r': return run(el);
    case 'f': {
      const type = prop(pr, 'type');
      if (type === 'lin') return `${braced(child(el, 'num'))}/${braced(child(el, 'den'))}`;
      if (type === 'noBar') return `\\genfrac{}{}{0pt}{}${braced(child(el, 'num'))}${braced(child(el, 'den'))}`;
      return `\\frac${braced(child(el, 'num'))}${braced(child(el, 'den'))}`;
    }
    case 'sSup': return `${base(child(el, 'e'))}^${braced(child(el, 'sup'))}`;
    case 'sSub': return `${base(child(el, 'e'))}_${braced(child(el, 'sub'))}`;
    case 'sSubSup': return `${base(child(el, 'e'))}_${braced(child(el, 'sub'))}^${braced(child(el, 'sup'))}`;
    case 'sPre': return `{}_${braced(child(el, 'sub'))}^${braced(child(el, 'sup'))}${braced(child(el, 'e'))}`;
    case 'rad': {
      const degree = child(el, 'deg');
      const hidden = on(pr, 'degHide') || !degree || !args(degree);
      return hidden ? `\\sqrt${braced(child(el, 'e'))}` : `\\sqrt[${args(degree)}]${braced(child(el, 'e'))}`;
    }
    case 'nary': {
      const chr = prop(pr, 'chr') || '∫';
      const op = NARY[chr] ?? literal(chr);
      const sub = on(pr, 'subHide') ? '' : args(child(el, 'sub'));
      const sup = on(pr, 'supHide') ? '' : args(child(el, 'sup'));
      return `${op}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}${braced(child(el, 'e'))}`;
    }
    case 'd': {
      const begin = prop(pr, 'begChr') ?? '(';
      const end = prop(pr, 'endChr') ?? ')';
      const separator = prop(pr, 'sepChr') ?? '|';
      const inner = [...el.children].filter((c) => c.localName === 'e').map(args).join(` ${fence(separator)} `);
      return `\\left${fence(begin)} ${inner} \\right${fence(end)}`;
    }
    case 'm': {
      const rows = [...el.children].filter((c) => c.localName === 'mr').map((r) => [...r.children].filter((c) => c.localName === 'e').map(args).join(' & '));
      return `\\begin{matrix} ${rows.join(' \\\\ ')} \\end{matrix}`;
    }
    case 'eqArr': return `\\begin{aligned} ${[...el.children].filter((c) => c.localName === 'e').map(args).join(' \\\\ ')} \\end{aligned}`;
    case 'acc': return `${ACCENTS[prop(pr, 'chr') || '̂'] ?? '\\hat'}${braced(child(el, 'e'))}`;
    case 'bar': return `${prop(pr, 'pos') === 'top' ? '\\overline' : '\\underline'}${braced(child(el, 'e'))}`;
    case 'groupChr': return `${prop(pr, 'pos') === 'top' ? '\\overbrace' : '\\underbrace'}${braced(child(el, 'e'))}`;
    case 'limLow': {
      const e = args(child(el, 'e'));
      // lim, max, min…: their limits stand under them as subscripts do
      return /^\\[A-Za-z]+$/.test(e) ? `${e}_${braced(child(el, 'lim'))}` : `\\underset${braced(child(el, 'lim'))}{${e}}`;
    }
    case 'limUpp': {
      const e = args(child(el, 'e'));
      return /^\\[A-Za-z]+$/.test(e) ? `${e}^${braced(child(el, 'lim'))}` : `\\overset${braced(child(el, 'lim'))}{${e}}`;
    }
    case 'func': return join([args(child(el, 'fName')), ' ', args(child(el, 'e'))]).replace(/ {2,}/g, ' ');
    case 'box': case 'borderBox': case 'phant': return args(child(el, 'e'));
    case 'rPr': case 'ctrlPr': return '';
    default:
      if (el.localName.endsWith('Pr')) return '';
      return args(el);
  }
}

/** The base of a script: one character as it is, more than one braced. */
function base(e: Element | null): string {
  const inner = args(e);
  return [...inner].length === 1 || /^\\[A-Za-z]+$/.test(inner) ? inner : `{${inner}}`;
}

/** One Word formula (`m:oMath`) as LaTeX, without its delimiters. */
export function ommlToLatex(oMath: Element): string {
  return join([...oMath.children].map(convert)).trim();
}
