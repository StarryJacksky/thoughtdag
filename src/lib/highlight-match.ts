// Highlights are captured from the RENDERED answer but must be located in
// the markdown SOURCE: a literal string match breaks the moment a selection
// crosses **bold**, `code`, a list marker or a soft line break — the mark
// then silently never renders. The fuzzy pattern below tolerates markdown
// punctuation between characters and normalizes whitespace runs, and is the
// single matcher shared by the response renderer (<mark>), the context
// builder ([Important] tags) and stale-highlight pruning — so "does this
// highlight still exist" always means the same thing everywhere.
const MD_NOISE = '[*_`~()#>\\[\\]|-]*';
// A whitespace gap in the selection may be a BLOCK boundary in the source:
// "\n- item", "\n\n2. item", "\n> quote", " | " between table cells, or a
// whole table delimiter row ("|---|---|") between header and body. After
// the whitespace, allow any run of list/quote/heading/cell prefixes —
// without this, any highlight crossing a list item or table cell can
// never match.
// A code fence line ("```bash", "~~~") is one more such boundary: a
// selection running from prose into a code block or out of one.
const WS_GAP = `\\s+(?:(?:\\d{1,3}[.)]|[-*+>|]|#{1,6}|[-:|]{3,}|[\`~]{3,}[^\\s\`~]*)\\s+)*`;

export function fuzzyHighlightRegex(text: string): RegExp | null {
  const chars = [...text.trim()];
  if (chars.length === 0) return null;
  const parts: string[] = [];
  let pendingWs = false;
  for (const ch of chars) {
    if (/\s/.test(ch)) { pendingWs = true; continue; }
    const escaped = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (parts.length === 0) parts.push(escaped);
    else if (pendingWs) parts.push(`${MD_NOISE}${WS_GAP}${MD_NOISE}${escaped}`);
    else parts.push(`${MD_NOISE}${escaped}`);
    pendingWs = false;
  }
  try {
    // Leading/trailing noise is swallowed into the match, so a wrapper
    // (<mark>, [Important]) encloses the WHOLE **bold** span instead of
    // splitting its delimiters apart.
    return new RegExp(MD_NOISE + parts.join('') + MD_NOISE, 'g');
  } catch {
    return null;
  }
}

// Code renders its source verbatim, so a <mark> spliced into a fenced block
// shows as literal text (#81). Fenced blocks (an unclosed one runs to the
// end, as the renderer draws it) and inline spans, in source order.
const CODE_RE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g;
const HAS_TEXT = /[^\s*_`~()#>[\]|-]/;

/** The parts of a matched source range a mark may wrap: fenced code is cut
    out of it, and a boundary that falls inside an inline code span grows to
    the whole span (a mark around `code` renders, one inside it does not). */
export function proseClipper(src: string): (start: number, end: number) => [number, number][] {
  const fences: [number, number][] = [];
  const inline: [number, number][] = [];
  for (const m of src.matchAll(CODE_RE)) (m[1] ? fences : inline).push([m.index!, m.index! + m[0].length]);
  return (start, end) => {
    for (const [a, b] of inline) {
      if (start > a && start < b) start = a;
      if (end > a && end < b) end = b;
    }
    const out: [number, number][] = [];
    let cur = start;
    for (const [a, b] of fences) {
      if (b <= cur || a >= end) continue;
      if (a > cur) out.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (cur < end) out.push([cur, end]);
    return out.filter(([a, b]) => HAS_TEXT.test(src.slice(a, b)));
  };
}

/** True when a selection starts and ends inside the same code block: no mark
    can be drawn there, so the selection menu offers no highlight for it. */
export function withinOneCodeBlock(range: Range): boolean {
  const pre = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('pre') ?? null;
  const a = pre(range.startContainer);
  return !!a && a === pre(range.endContainer);
}

export function highlightFoundIn(haystack: string, text: string): boolean {
  const re = fuzzyHighlightRegex(text);
  return re ? re.test(haystack) : false;
}

/** Drop highlights that no longer appear in the (new) response text —
    called whenever a node's displayed answer changes (generation, version
    switch, manual edit), so ghost highlights never outlive their text. */
export function pruneHighlights<T extends { text: string }>(highlights: T[] | undefined, response: string): T[] {
  const list = highlights ?? [];
  const kept = list.filter((h) => highlightFoundIn(response, h.text));
  return kept.length === list.length ? list : kept;
}
