import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Loader2, Quote } from 'lucide-react';
import type { Attachment } from '../../types';
import { readSource, readView, WorkspaceError } from '../../lib/workspace/client';
import type { ContentHash, ResourceRef } from '../../lib/workspace/contracts';
import { onFileEvent } from '../../lib/workspace/file-news';
import { pdfQuote, textQuote } from '../../lib/documents/quotes';
import { loadPdfjs, type Pdfjs } from '../../lib/pdfjs';
import { HtmlMaterialView } from '../HtmlMaterialView';
import { useT, fmt } from '../../i18n';
import PdfPage from './PdfPage';
import { docxHasMath, readDocx } from '../../lib/docx/read';
import { ommlToMathml } from '../../lib/docx/mathml';

// A file that is read, not typed into: a PDF, an image, an HTML page, a
// Word document. It shows the file as its source gives it and lets a part
// of it be quoted. A quote is a reference that can be found again: a page of
// a PDF, a passage by its words. What is shown of a Word document is the
// text taken out of it, and it says so: the file itself is not that text.
//
// Markup and scripts in a file are shown, never run: HTML goes through the
// same sanitizing, sandboxed view the rest of the app reads HTML with.
//
// What is shown is one version of the file, and the reader knows which.
// When the workspace reports another, the file is read again and what was
// selected in the old one is let go; when the file is gone the reader says
// so instead of showing what it last held. A quote names the place that
// was selected (found from the selection itself, never by looking for its
// words) and the version it was selected in.

interface Props {
  resourceRef: ResourceRef;
  /** the file's name: what kind of reader it gets */
  name: string;
  /** called with a reference to the part the person chose to quote, and the words of it */
  onQuote?: (ref: ResourceRef, words: string) => void;
}

type Loaded =
  | { kind: 'image'; url: string; revision: ContentHash }
  | { kind: 'html'; attachment: Attachment; revision: ContentHash }
  | { kind: 'pdf'; pdfjs: Pdfjs; doc: PDFDocumentProxy; revision: ContentHash }
  // `segments`: the text with its formulas drawn (a Word document that has formulas); `text` is then exactly what they show
  | { kind: 'derived-text'; text: string; revision: ContentHash; segments?: Segment[] };

/** A piece of the text a reader shows: words, or a formula drawn (MathML made by mathml.ts). */
type Segment = { text: string } | { math: Element };

/** A formula drawn where it stands: the element is put into the page as it was made, never as markup. */
function Attached({ node }: { node: Element }) {
  const host = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    host.current?.appendChild(node);
    return () => { node.remove(); };
  }, [node]);
  return <span ref={host} data-reader-math />;
}

const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ResourceReader({ resourceRef, name, onQuote }: Props) {
  const t = useT();
  const fileId = resourceRef.fileId;
  const extension = extensionOf(name);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  // which reading of the file is wanted: it goes up when the workspace reports a version other than the one shown
  const [reading, setReading] = useState(0);
  // the file is not where it was: nothing of it is shown as if it were
  const [lost, setLost] = useState(false);
  const shownRevision = useRef<ContentHash | null>(null);

  const wasLost = useRef(false);

  // What the workspace reports about this file while the reader is open. It is read by what the record says
  // the file is now, whatever the kind of news: a file that moved may have been changed on the way, or be one
  // that was lost and is found again somewhere else. A file that is there again is read again; a file whose
  // version is not the one on screen is read again; a file that only moved, as it was, is left as it is.
  useEffect(() => onFileEvent(fileId, (event) => {
    const status = event.record?.status;
    if (event.change === 'missing' || event.change === 'ambiguous' || status === 'missing' || status === 'ambiguous') {
      wasLost.current = true;
      setLost(true);
      return;
    }
    const back = event.change === 'restored' || wasLost.current;
    if (back) { wasLost.current = false; setLost(false); }
    const otherVersion = !!event.observedRevision && event.observedRevision !== shownRevision.current;
    // news of the version that is on screen is not a reason to read it again
    if (!back && !otherVersion) return;
    // what was selected was selected in the old version: it is not carried over to the new one
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && scroller.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) selection.removeAllRanges();
    shownRevision.current = null;
    setFailed(null);
    setLoaded(null);
    setReading((n) => n + 1);
  }), [fileId]);

  useEffect(() => {
    let gone = false;
    let url: string | null = null;
    let doc: PDFDocumentProxy | null = null;
    (async () => {
      if (extension === 'html' || extension === 'htm') {
        const read = await readSource(fileId);
        const content = typeof read.payload === 'string' ? read.payload : new TextDecoder().decode(read.payload as Uint8Array);
        return { kind: 'html', attachment: { id: `reader:${fileId}`, name, type: 'text/html', size: content.length, content }, revision: read.contentHash } satisfies Loaded;
      }
      const read = await readView(fileId);
      const bytes = typeof read.payload === 'string' ? new TextEncoder().encode(read.payload) : read.payload as Uint8Array;
      if (extension === 'pdf') {
        const pdfjs = await loadPdfjs();
        doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        return { kind: 'pdf', pdfjs, doc, revision: read.contentHash } satisfies Loaded;
      }
      if (extension === 'docx') {
        // with formulas, it is read here and its formulas drawn; the text is what is shown, so a quote is counted on it
        if (await docxHasMath(bytes.slice())) {
          const { blocks } = await readDocx(bytes.slice());
          const segments: Segment[] = [];
          blocks.forEach((block, i) => {
            if (i > 0) segments.push({ text: '\n\n' });
            for (const part of block.parts) segments.push(part.kind === 'text' ? { text: part.text } : { math: ommlToMathml(part.omml, part.display, document) });
          });
          const text = segments.map((s) => ('text' in s ? s.text : s.math.textContent ?? '')).join('');
          return { kind: 'derived-text', text, segments, revision: read.contentHash } satisfies Loaded;
        }
        const mammoth = await import('mammoth');
        const text = (await mammoth.extractRawText({ arrayBuffer: bytes.slice().buffer as ArrayBuffer })).value;
        return { kind: 'derived-text', text, revision: read.contentHash } satisfies Loaded;
      }
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: `image/${extension === 'jpg' ? 'jpeg' : extension}` }));
      return { kind: 'image', url, revision: read.contentHash } satisfies Loaded;
    })().then(
      (result) => { if (gone) { if (url) URL.revokeObjectURL(url); void doc?.destroy(); } else { shownRevision.current = result.revision; setLoaded(result); } },
      (e) => { if (!gone) setFailed(e instanceof WorkspaceError && e.code === 'too-large' ? t('surface.tooLargeToShow') : why(e)); },
    );
    return () => { gone = true; if (url) URL.revokeObjectURL(url); void doc?.destroy(); };
    // the file and its kind are fixed for the life of the reader; `reading` asks for the file to be read again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, extension, reading]);

  // pages are drawn as wide as the reader, within reason
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(Math.max(280, Math.min(900, Math.floor(el.getBoundingClientRect().width) - 64)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [loaded?.kind]);

  // which page of a PDF is in view: a quote of "this page" names it
  const pages = loaded?.kind === 'pdf' ? loaded.doc.numPages : 0;
  const onScroll = useMemo(() => () => {
    const el = scroller.current;
    if (!el) return;
    const middle = el.getBoundingClientRect().top + el.clientHeight / 2;
    for (const holder of Array.from(el.querySelectorAll<HTMLElement>('[data-page]'))) {
      const box = holder.getBoundingClientRect();
      if (box.top <= middle && box.bottom >= middle) { setPage(Number(holder.dataset.page)); return; }
    }
  }, []);

  /**
   * Quote what is selected. The place is taken from the selection itself:
   * both its ends must be in this reader. In a PDF the reference names
   * every page the selection runs over; in text it names the passage by
   * where it starts and ends in the text that is shown, so that the same
   * words standing elsewhere in it are not mistaken for it. With nothing
   * selected, or a selection that runs out of the reader, there is nothing
   * to quote.
   */
  const quote = () => {
    const within = scroller.current;
    if (!onQuote || !loaded || lost || !within) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    // a range runs from its start to its end whichever way the selection was dragged
    const range = selection.getRangeAt(0);
    if (!within.contains(range.startContainer) || !within.contains(range.endContainer)) return;
    if (loaded.kind === 'pdf') {
      const pages: number[] = [];
      for (const holder of Array.from(within.querySelectorAll<HTMLElement>('[data-page]'))) {
        if (!range.intersectsNode(holder)) continue;
        // the part of the selection that is on this page: a page the selection only touches the edge of is not quoted
        const part = range.cloneRange();
        if (!holder.contains(range.startContainer)) part.setStart(holder, 0);
        if (!holder.contains(range.endContainer)) part.setEnd(holder, holder.childNodes.length);
        if (part.toString().trim()) pages.push(Number(holder.dataset.page));
      }
      const words = range.toString();
      const ref = words.trim() ? pdfQuote(fileId, pages, undefined, loaded.revision) : null;
      if (ref) onQuote(ref, words);
    } else if (loaded.kind === 'derived-text') {
      const shown = within.querySelector<HTMLElement>('[data-reader-text]');
      if (!shown || !shown.contains(range.startContainer) || !shown.contains(range.endContainer)) return;
      const before = document.createRange();
      before.selectNodeContents(shown);
      before.setEnd(range.startContainer, range.startOffset);
      const from = before.toString().length;
      const to = from + range.toString().length;
      const words = loaded.text.slice(from, to);
      const ref = words.trim() ? textQuote(fileId, loaded.text, from, to, loaded.revision) : null;
      if (ref) onQuote(ref, words);
    }
  };

  if (lost) return <p className="flex-1 px-4 py-6 text-xs text-amber-800 leading-relaxed" data-reader-gone>{t('surface.fileGone')}</p>;
  if (failed) return <p className="flex-1 px-4 py-6 text-xs text-ink-muted leading-relaxed" data-reader-failed>{fmt(t('workspace.failed'), { why: failed })}</p>;
  if (!loaded) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-xs text-ink-muted" data-reader-loading>
        <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-accent" /> {t('workspace.loading')}
      </div>
    );
  }
  const quotable = !!onQuote && (loaded.kind === 'pdf' || loaded.kind === 'derived-text');
  return (
    <div className="flex flex-col flex-1 min-h-0" data-reader={loaded.kind}>
      {loaded.kind === 'derived-text' && (
        <p className="shrink-0 px-3 py-1.5 bg-wash border-b border-line/60 text-2xs text-ink-muted leading-snug" data-reader-derived>{t('surface.derivedText')}</p>
      )}
      <div ref={scroller} onScroll={loaded.kind === 'pdf' ? onScroll : undefined} className="flex-1 min-h-0 overflow-auto bg-wash/40">
        {loaded.kind === 'image' && <img src={loaded.url} alt={name} className="max-w-full mx-auto my-4 rounded shadow-sm" draggable={false} data-reader-image />}
        {loaded.kind === 'html' && <HtmlMaterialView att={loaded.attachment} onSelect={() => {}} />}
        {loaded.kind === 'derived-text' && (
          <pre className="px-5 py-4 text-sm text-ink leading-relaxed whitespace-pre-wrap break-words font-sans" data-reader-text>
            {loaded.segments ? loaded.segments.map((s, i) => ('text' in s ? <Fragment key={i}>{s.text}</Fragment> : <Attached key={i} node={s.math} />)) : loaded.text}
          </pre>
        )}
        {loaded.kind === 'pdf' && (
          <div className="flex flex-col items-center gap-4 py-4 pl-10 pr-4">
            {Array.from({ length: pages }, (_, i) => <PdfPage key={i + 1} doc={loaded.doc} pdfjs={loaded.pdfjs} pageNo={i + 1} width={width} />)}
          </div>
        )}
      </div>
      {(quotable || loaded.kind === 'pdf') && (
        <div className="shrink-0 flex items-center justify-between gap-2 border-t border-line/70 px-3 py-1.5">
          <span className="text-2xs text-ink-faint font-mono" data-reader-page>{loaded.kind === 'pdf' ? `p.${page} / ${pages}` : ''}</span>
          {quotable && (
            <button onClick={quote} data-reader-quote title={t('surface.quoteTitle')}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-2xs text-accent bg-accent/10 hover:bg-accent/20 transition-colors">
              <Quote size={11} strokeWidth={1.75} /> {t('surface.quote')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
