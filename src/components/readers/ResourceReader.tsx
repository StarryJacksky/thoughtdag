import { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Loader2, Quote } from 'lucide-react';
import type { Attachment } from '../../types';
import { readSource, readView, WorkspaceError } from '../../lib/workspace/client';
import type { ResourceRef } from '../../lib/workspace/contracts';
import { pdfQuote, textQuote } from '../../lib/documents/quotes';
import { loadPdfjs, type Pdfjs } from '../../lib/pdfjs';
import { HtmlMaterialView } from '../HtmlMaterialView';
import { useT, fmt } from '../../i18n';
import PdfPage from './PdfPage';

// A file that is read, not typed into: a PDF, an image, an HTML page, a
// Word document. It shows the file as its source gives it and lets a part
// of it be quoted. A quote is a reference that can be found again: a page of
// a PDF, a passage by its words. What is shown of a Word document is the
// text taken out of it, and it says so: the file itself is not that text.
//
// Markup and scripts in a file are shown, never run: HTML goes through the
// same sanitizing, sandboxed view the rest of the app reads HTML with.

interface Props {
  resourceRef: ResourceRef;
  /** the file's name: what kind of reader it gets */
  name: string;
  /** called with a reference to the part the person chose to quote, and the words of it */
  onQuote?: (ref: ResourceRef, words: string) => void;
}

type Loaded =
  | { kind: 'image'; url: string }
  | { kind: 'html'; attachment: Attachment; revision: string }
  | { kind: 'pdf'; pdfjs: Pdfjs; doc: PDFDocumentProxy }
  | { kind: 'derived-text'; text: string; revision: string };

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
        return { kind: 'pdf', pdfjs, doc } satisfies Loaded;
      }
      if (extension === 'docx') {
        const mammoth = await import('mammoth');
        const text = (await mammoth.extractRawText({ arrayBuffer: bytes.slice().buffer as ArrayBuffer })).value;
        return { kind: 'derived-text', text, revision: read.contentHash } satisfies Loaded;
      }
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: `image/${extension === 'jpg' ? 'jpeg' : extension}` }));
      return { kind: 'image', url } satisfies Loaded;
    })().then(
      (result) => { if (gone) { if (url) URL.revokeObjectURL(url); void doc?.destroy(); } else setLoaded(result); },
      (e) => { if (!gone) setFailed(e instanceof WorkspaceError && e.code === 'too-large' ? t('surface.tooLargeToShow') : why(e)); },
    );
    return () => { gone = true; if (url) URL.revokeObjectURL(url); void doc?.destroy(); };
    // the file and its kind are fixed for the life of the reader
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, extension]);

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
   * Quote what is selected. In a PDF the reference names the page the
   * selection is on; in text it names the passage by its own words. With
   * nothing selected there is nothing to quote.
   */
  const quote = () => {
    if (!onQuote || !loaded) return;
    const selection = window.getSelection();
    const words = selection && !selection.isCollapsed ? selection.toString() : '';
    if (!words.trim() || !selection) return;
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    if (!anchor || !scroller.current?.contains(anchor)) return;
    if (loaded.kind === 'pdf') {
      const on = anchor.closest<HTMLElement>('[data-page]');
      const ref = on ? pdfQuote(fileId, Number(on.dataset.page)) : null;
      if (ref) onQuote(ref, words);
    } else if (loaded.kind === 'derived-text') {
      const at = loaded.text.indexOf(words);
      const ref = at >= 0 ? textQuote(fileId, loaded.text, at, at + words.length, loaded.revision) : null;
      if (ref) onQuote(ref, words);
    }
  };

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
        {loaded.kind === 'derived-text' && <pre className="px-5 py-4 text-sm text-ink leading-relaxed whitespace-pre-wrap break-words font-sans" data-reader-text>{loaded.text}</pre>}
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
