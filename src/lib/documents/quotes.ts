// References to a part of a file: what "quote this" hands on. A reference
// names the file by its identity and the part by something that can be
// found again: a passage by its own words and the words around it, a place
// in a PDF by its page. A bare line number is never the reference: lines
// shift with every edit, and a number that still points somewhere says
// nothing about whether it points at the same thing.

import type { ContentHash, ResourceRef } from '../workspace/contracts';

/** How much of the text on each side of a passage is kept to find it again. */
const CONTEXT = 48;

/**
 * A reference to the passage of `text` from `from` to `to`. It carries the
 * passage, what stands before and after it, the revision of the file it
 * was taken from, and the lines it was on as a help to the reader.
 */
export function textQuote(fileId: string, text: string, from: number, to: number, baseRevision: ContentHash): ResourceRef | null {
  const [start, end] = [Math.max(0, Math.min(from, to)), Math.min(text.length, Math.max(from, to))];
  if (end <= start) return null;
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length;
  return {
    fileId,
    selector: {
      kind: 'text',
      quote: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT), start),
      suffix: text.slice(end, end + CONTEXT),
      baseRevision,
      lines: [lineOf(start), lineOf(end)],
    },
    version: { kind: 'live' },
    payload: 'text',
  };
}

/**
 * A reference to pages of a PDF: every page the quoted words are on, in
 * order. `rect` is a region of one page, [x0, y0, x1, y1] as fractions of
 * it. `baseRevision` is the content of the file the pages were quoted
 * from, when it is known: page numbers mean something only for that.
 */
export function pdfQuote(fileId: string, pages: number | number[], rect?: [number, number, number, number], baseRevision?: ContentHash): ResourceRef | null {
  const list = [...new Set(Array.isArray(pages) ? pages : [pages])];
  if (list.length === 0 || list.some((page) => !Number.isInteger(page) || page < 1)) return null;
  list.sort((a, b) => a - b);
  return { fileId, selector: { kind: 'pdf', pages: list, ...(rect ? { rect } : {}), ...(baseRevision ? { baseRevision } : {}) }, version: { kind: 'live' }, payload: 'text' };
}
