// Word's formulas (OMML) as MathML, for drawing them where a Word document
// is read: a fraction a fraction, a sum a sum with its limits, a matrix a
// table. The browser draws MathML itself. Everything is made element by
// element with the DOM; nothing of the document is ever parsed as markup
// here, so a document cannot put anything but formula text on the page.

const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const MML = 'http://www.w3.org/1998/Math/MathML';

/** The first child of `el` named `name` in the OMML namespace. */
const child = (el: Element | null | undefined, name: string): Element | null => (el ? [...el.children].find((c) => c.namespaceURI === M && c.localName === name) ?? null : null);
/** An OMML property's value (`<m:chr m:val="∑"/>`), or null when it is not there. */
const prop = (props: Element | null, name: string): string | null => {
  const p = child(props, name);
  if (!p) return null;
  return p.getAttributeNS(M, 'val') ?? p.getAttribute('m:val') ?? '';
};
/** Whether an on/off property is on: there, and not set to off. */
const on = (props: Element | null, name: string) => { const v = prop(props, name); return v !== null && v !== '0' && v !== 'off' && v !== 'false'; };

export function ommlToMathml(oMath: Element, display: boolean, doc: Document): Element {
  const make = (name: string, ...children: (Node | null)[]) => {
    const el = doc.createElementNS(MML, name);
    for (const c of children) if (c) el.appendChild(c);
    return el;
  };
  const text = (name: string, value: string, attrs: Record<string, string> = {}) => {
    const el = doc.createElementNS(MML, name);
    el.textContent = value;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const mrow = (...children: (Node | null)[]) => make('mrow', ...children);

  /** A run of formula text, as tokens: numbers, letters (an upright word as one name), and operators. */
  const runOf = (r: Element): Node[] => {
    const value = [...r.getElementsByTagNameNS(M, 't')].map((t) => t.textContent ?? '').join('');
    const props = child(r, 'rPr');
    if (props && child(props, 'nor')) return [text('mtext', value)];
    const upright = prop(props, 'sty') === 'p';
    const tokens: Node[] = [];
    for (const piece of value.match(/\d+(?:\.\d+)?|\p{L}+|\s+|./gsu) ?? []) {
      if (/^\s+$/.test(piece)) continue;
      if (/^\d/.test(piece)) tokens.push(text('mn', piece));
      else if (/^\p{L}/u.test(piece)) {
        if (upright) tokens.push(text('mi', piece, piece.length > 1 ? {} : { mathvariant: 'normal' }));
        else for (const letter of piece) tokens.push(text('mi', letter));
      } else tokens.push(text('mo', piece));
    }
    return tokens;
  };

  /** The children of an OMML element (an argument, a row), as one MathML row. */
  const arg = (el: Element | null): Element => {
    const row = mrow();
    if (el) for (const c of [...el.children]) for (const n of convert(c)) row.appendChild(n);
    return row;
  };

  const convert = (el: Element): Node[] => {
    if (el.namespaceURI !== M) {
      // a run of the document inside a formula (w:r): its text
      const value = [...el.getElementsByTagNameNS('*', 't')].map((t) => t.textContent ?? '').join('');
      return value ? [text('mtext', value)] : [];
    }
    const pr = child(el, `${el.localName}Pr`);
    switch (el.localName) {
      case 'r': return runOf(el);
      case 'f': {
        const type = prop(pr, 'type');
        if (type === 'lin') return [mrow(arg(child(el, 'num')), text('mo', '/'), arg(child(el, 'den')))];
        const frac = make('mfrac', arg(child(el, 'num')), arg(child(el, 'den')));
        if (type === 'noBar') frac.setAttribute('linethickness', '0');
        return [frac];
      }
      case 'sSup': return [make('msup', arg(child(el, 'e')), arg(child(el, 'sup')))];
      case 'sSub': return [make('msub', arg(child(el, 'e')), arg(child(el, 'sub')))];
      case 'sSubSup': return [make('msubsup', arg(child(el, 'e')), arg(child(el, 'sub')), arg(child(el, 'sup')))];
      case 'sPre': return [make('mmultiscripts', arg(child(el, 'e')), make('mprescripts'), arg(child(el, 'sub')), arg(child(el, 'sup')))];
      case 'rad': {
        const degree = child(el, 'deg');
        return on(pr, 'degHide') || !degree || degree.children.length === 0 ? [make('msqrt', arg(child(el, 'e')))] : [make('mroot', arg(child(el, 'e')), arg(degree))];
      }
      case 'nary': {
        const op = text('mo', prop(pr, 'chr') || '∫', { largeop: 'true' });
        const sub = on(pr, 'subHide') ? null : arg(child(el, 'sub'));
        const sup = on(pr, 'supHide') ? null : arg(child(el, 'sup'));
        const under = prop(pr, 'limLoc') === 'undOvr';
        const limited = sub && sup ? make(under ? 'munderover' : 'msubsup', op, sub, sup)
          : sub ? make(under ? 'munder' : 'msub', op, sub)
          : sup ? make(under ? 'mover' : 'msup', op, sup)
          : op;
        return [mrow(limited, arg(child(el, 'e')))];
      }
      case 'd': {
        const begin = prop(pr, 'begChr') ?? '(';
        const end = prop(pr, 'endChr') ?? ')';
        const separator = prop(pr, 'sepChr') ?? '|';
        const row = mrow();
        if (begin) row.appendChild(text('mo', begin, { fence: 'true' }));
        [...el.children].filter((c) => c.localName === 'e').forEach((e, i) => {
          if (i > 0) row.appendChild(text('mo', separator, { separator: 'true' }));
          row.appendChild(arg(e));
        });
        if (end) row.appendChild(text('mo', end, { fence: 'true' }));
        return [row];
      }
      case 'm': {
        const table = make('mtable');
        for (const r of [...el.children].filter((c) => c.localName === 'mr')) {
          const tr = make('mtr');
          for (const e of [...r.children].filter((c) => c.localName === 'e')) tr.appendChild(make('mtd', arg(e)));
          table.appendChild(tr);
        }
        return [table];
      }
      case 'eqArr': {
        const table = make('mtable');
        for (const e of [...el.children].filter((c) => c.localName === 'e')) table.appendChild(make('mtr', make('mtd', arg(e))));
        return [table];
      }
      case 'acc': {
        const over = make('mover', arg(child(el, 'e')), text('mo', prop(pr, 'chr') || '̂'));
        over.setAttribute('accent', 'true');
        return [over];
      }
      case 'bar': {
        const top = prop(pr, 'pos') === 'top';
        const el2 = make(top ? 'mover' : 'munder', arg(child(el, 'e')), text('mo', '‾', { stretchy: 'true' }));
        el2.setAttribute(top ? 'accent' : 'accentunder', 'true');
        return [el2];
      }
      case 'groupChr': {
        const top = prop(pr, 'pos') === 'top';
        return [make(top ? 'mover' : 'munder', arg(child(el, 'e')), text('mo', prop(pr, 'chr') || '⏟', { stretchy: 'true' }))];
      }
      case 'limLow': return [make('munder', arg(child(el, 'e')), arg(child(el, 'lim')))];
      case 'limUpp': return [make('mover', arg(child(el, 'e')), arg(child(el, 'lim')))];
      case 'func': return [mrow(arg(child(el, 'fName')), text('mo', '⁡'), arg(child(el, 'e')))];
      case 'box': case 'borderBox': case 'phant': return [arg(child(el, 'e'))];
      // properties and empty arguments draw nothing of their own
      case 'rPr': case 'ctrlPr': return [];
      default:
        if (el.localName.endsWith('Pr')) return [];
        return [arg(el)];
    }
  };

  const math = make('math', arg(oMath));
  if (display) math.setAttribute('display', 'block');
  return math;
}
