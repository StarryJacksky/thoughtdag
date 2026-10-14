// LaTeX formulas as Word writes formulas (OMML, Office Math Markup): a
// fraction is Word's fraction, a sum Word's n-ary operator, and so on, so
// that the formula can be edited in Word as a formula. KaTeX reads the
// LaTeX (as the editors draw it) and gives MathML; MathML is then written
// as OMML, structure for structure. What is not known is written as its
// text, never dropped; a formula KaTeX cannot read is written as its LaTeX.

import katex from 'katex';

const MML = 'http://www.w3.org/1998/Math/MathML';

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const val = (value: string) => ` m:val="${escapeXml(value)}"`;

/** A run of formula text. `style`: p upright, b bold, bi bold italic; `script`: Word's script (double-struck, …); `plain`: words, not mathematics. */
function run(text: string, opts: { style?: 'p' | 'b' | 'bi' | 'i'; script?: string; plain?: boolean } = {}): string {
  if (!text) return '';
  const props = [
    opts.plain ? '<m:nor/>' : '',
    opts.script ? `<m:scr${val(opts.script)}/>` : '',
    opts.style ? `<m:sty${val(opts.style)}/>` : '',
  ].join('');
  return `<m:r>${props ? `<m:rPr>${props}</m:rPr>` : ''}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;
}

/** The operators Word writes as n-ary: an operator with limits that applies to what follows it. */
const NARY = new Set(['∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '∰', '⋃', '⋂', '⋁', '⋀', '⨁', '⨂', '⨀']);
const INTEGRALS = new Set(['∫', '∬', '∭', '∮', '∯', '∰']);
/** KaTeX's accents, as the combining characters Word's accents are named by. */
const ACCENTS: Record<string, string> = { '^': '̂', 'ˆ': '̂', '~': '̃', '˜': '̃', '˙': '̇', '¨': '̈', '→': '⃗', '⃗': '⃗', 'ˉ': '̅', '¯': '̅', '˘': '̆', 'ˇ': '̌', '´': '́', '`': '̀', '˚': '̊' };
const BARS = new Set(['‾', '¯', '_', '―', '−', 'ˉ']);

const kids = (el: Element) => [...el.children];
const isMo = (el: Element | undefined): el is Element => !!el && el.localName === 'mo';
const textOf = (el: Element) => (el.textContent ?? '').replace(/⁡|⁢|⁣/g, '');

/** The large operator an element is, if it is one (the operator itself, or the operator with its limits). */
function naryOf(el: Element): { chr: string; sub: Element | null; sup: Element | null; under: boolean } | null {
  const name = el.localName;
  const base = name === 'mo' ? el : ['munderover', 'msubsup', 'munder', 'mover', 'msub', 'msup'].includes(name) ? el.children[0] : null;
  if (!base || !isMo(base) || !NARY.has(textOf(base).trim())) return null;
  const chr = textOf(base).trim();
  const [, a, b] = kids(el);
  switch (name) {
    case 'mo': return { chr, sub: null, sup: null, under: false };
    case 'munderover': return { chr, sub: a ?? null, sup: b ?? null, under: true };
    case 'msubsup': return { chr, sub: a ?? null, sup: b ?? null, under: false };
    case 'munder': return { chr, sub: a ?? null, sup: null, under: true };
    case 'msub': return { chr, sub: a ?? null, sup: null, under: false };
    case 'mover': return { chr, sub: null, sup: a ?? null, under: true };
    default: return { chr, sub: null, sup: a ?? null, under: false };
  }
}

/** A row of MathML elements, as OMML: a large operator takes what follows it in the row as what it applies to. */
function row(elements: Element[]): string {
  let out = '';
  for (let i = 0; i < elements.length; i++) {
    const nary = naryOf(elements[i]);
    if (nary) {
      const rest = elements.slice(i + 1);
      const loc = nary.under && !INTEGRALS.has(nary.chr) ? 'undOvr' : 'subSup';
      out += `<m:nary><m:naryPr><m:chr${val(nary.chr)}/><m:limLoc${val(loc)}/>${nary.sub ? '' : '<m:subHide m:val="1"/>'}${nary.sup ? '' : '<m:supHide m:val="1"/>'}</m:naryPr>`
        + `<m:sub>${nary.sub ? node(nary.sub) : ''}</m:sub><m:sup>${nary.sup ? node(nary.sup) : ''}</m:sup><m:e>${row(rest)}</m:e></m:nary>`;
      return out;
    }
    out += node(elements[i]);
  }
  return out;
}

/** A row whose first and last elements are a pair of fences: Word's delimiters around what is between. */
function fenced(el: Element): string | null {
  const items = kids(el);
  const first = items[0];
  const last = items[items.length - 1];
  if (items.length < 2 || !isMo(first) || !isMo(last) || first.getAttribute('fence') !== 'true' || last.getAttribute('fence') !== 'true') return null;
  return `<m:d><m:dPr><m:begChr${val(textOf(first))}/><m:endChr${val(textOf(last))}/></m:dPr><m:e>${row(items.slice(1, -1))}</m:e></m:d>`;
}

const SCRIPTS: Record<string, string> = { 'double-struck': 'double-struck', script: 'script', fraktur: 'fraktur', 'sans-serif': 'sans-serif', monospace: 'monospace' };

function token(el: Element): string {
  const text = textOf(el);
  const variant = el.getAttribute('mathvariant') ?? '';
  const script = SCRIPTS[variant];
  const style: 'p' | 'b' | 'bi' | undefined = variant === 'bold' ? 'b' : variant === 'bold-italic' ? 'bi' : variant === 'normal' || script ? 'p' : undefined;
  if (el.localName === 'mi') {
    // a name of more than one letter (sin, log, a name in \operatorname) is upright, as a function name is
    return run(text, { style: style ?? ([...text].length > 1 ? 'p' : undefined), script });
  }
  if (el.localName === 'mtext') return run(text.replace(/\u00a0/g, ' '), { plain: true });
  return run(text, { style, script });
}

function node(el: Element): string {
  const items = kids(el);
  const at = (i: number) => (items[i] ? node(items[i]) : '');
  switch (el.localName) {
    case 'math': case 'mrow': case 'mstyle': case 'mpadded': case 'menclose': case 'mtd': case 'mtr':
      return fenced(el) ?? row(items);
    case 'semantics': return items[0] ? node(items[0]) : '';
    case 'annotation': case 'annotation-xml': case 'mphantom': case 'mspace': case 'none': case 'mprescripts': return '';
    case 'mi': case 'mn': case 'mo': case 'mtext': case 'ms': return token(el);
    case 'mfrac': {
      const thickness = el.getAttribute('linethickness');
      const noBar = thickness !== null && parseFloat(thickness) === 0;
      return `<m:f>${noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''}<m:num>${at(0)}</m:num><m:den>${at(1)}</m:den></m:f>`;
    }
    case 'msup': return naryOf(el) ? row([el]) : `<m:sSup><m:e>${at(0)}</m:e><m:sup>${at(1)}</m:sup></m:sSup>`;
    case 'msub': return naryOf(el) ? row([el]) : `<m:sSub><m:e>${at(0)}</m:e><m:sub>${at(1)}</m:sub></m:sSub>`;
    case 'msubsup': return naryOf(el) ? row([el]) : `<m:sSubSup><m:e>${at(0)}</m:e><m:sub>${at(1)}</m:sub><m:sup>${at(2)}</m:sup></m:sSubSup>`;
    case 'msqrt': return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${row(items)}</m:e></m:rad>`;
    case 'mroot': return `<m:rad><m:deg>${at(1)}</m:deg><m:e>${at(0)}</m:e></m:rad>`;
    case 'mover': case 'munder': {
      if (naryOf(el)) return row([el]);
      const mark = items[1];
      const over = el.localName === 'mover';
      const markText = mark && isMo(mark) ? textOf(mark).trim() : '';
      if (mark && isMo(mark) && BARS.has(markText) && (mark.getAttribute('stretchy') === 'true' || el.getAttribute(over ? 'accent' : 'accentunder') === 'true')) {
        return `<m:bar><m:barPr><m:pos${val(over ? 'top' : 'bot')}/></m:barPr><m:e>${at(0)}</m:e></m:bar>`;
      }
      if (over && mark && isMo(mark) && (el.getAttribute('accent') === 'true' || ACCENTS[markText])) {
        return `<m:acc><m:accPr><m:chr${val(ACCENTS[markText] ?? markText)}/></m:accPr><m:e>${at(0)}</m:e></m:acc>`;
      }
      return over ? `<m:limUpp><m:e>${at(0)}</m:e><m:lim>${at(1)}</m:lim></m:limUpp>` : `<m:limLow><m:e>${at(0)}</m:e><m:lim>${at(1)}</m:lim></m:limLow>`;
    }
    case 'munderover': {
      if (naryOf(el)) return row([el]);
      return `<m:limUpp><m:e><m:limLow><m:e>${at(0)}</m:e><m:lim>${at(1)}</m:lim></m:limLow></m:e><m:lim>${at(2)}</m:lim></m:limUpp>`;
    }
    case 'mtable': {
      const rows = items.filter((r) => r.localName === 'mtr' || r.localName === 'mlabeledtr');
      const columns = Math.max(1, ...rows.map((r) => r.children.length));
      return `<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count${val(String(columns))}/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>`
        + rows.map((r) => `<m:mr>${kids(r).map((cell) => `<m:e>${node(cell)}</m:e>`).join('')}</m:mr>`).join('') + '</m:m>';
    }
    default:
      // something this does not know: what it says, kept
      return items.length > 0 ? row(items) : run(textOf(el));
  }
}

/** A MathML `<math>` element, as the inside of an OMML formula. */
export function mathmlToOmml(math: Element): string {
  return node(math);
}

/** A LaTeX formula as one OMML formula, `<m:oMath>…</m:oMath>`. A formula that cannot be read is written as its LaTeX. */
export function latexToOmml(tex: string): string {
  const html = katex.renderToString(tex, { output: 'mathml', displayMode: true, throwOnError: false, trust: false, strict: 'ignore' });
  const math = new DOMParser().parseFromString(html, 'text/html').getElementsByTagNameNS(MML, 'math')[0];
  const inner = math ? mathmlToOmml(math) : '';
  return `<m:oMath>${inner || run(tex)}</m:oMath>`;
}
