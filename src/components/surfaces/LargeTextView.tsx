import { useCallback, useEffect, useRef, useState } from 'react';
import { readTextRange } from '../../lib/workspace/client';
import { isProse } from '../editors/codemirror-document';
import { useT, fmt } from '../../i18n';

// A text file too large to open for typing (above 8 MiB), shown read-only:
// the beginning first, and more of it as the person scrolls down or asks
// for it, a part at a time. None of it goes into a document: nothing can
// be typed, nothing is drafted or saved. If the file changes while it is
// being shown, what is shown is let go and read again from the start.

/** How much of the file is read at a time. */
const PART_BYTES = 512 * 1024;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export default function LargeTextView({ fileId, name }: { fileId: string; name: string }) {
  const t = useT();
  const [parts, setParts] = useState<string[]>([]);
  const [next, setNext] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [restarted, setRestarted] = useState(false);
  const stamp = useRef<string | null>(null);
  const busy = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);

  const more = useCallback(async (from: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const part = await readTextRange(fileId, from, PART_BYTES);
      if (stamp.current !== null && part.stamp !== stamp.current) {
        // the file changed while it was being shown: start again from the beginning
        stamp.current = null;
        setParts([]); setNext(0); setRestarted(true);
        busy.current = false;
        void more(0);
        return;
      }
      stamp.current = part.stamp;
      setSize(part.size);
      setParts((shown) => (from === 0 ? [part.text] : [...shown, part.text]));
      setNext(part.nextOffset);
    } catch (e) {
      setFailed(why(e));
    } finally {
      busy.current = false;
    }
  }, [fileId]);

  useEffect(() => { void more(0); }, [more]);
  const done = size !== null && next >= size;
  // near the bottom, the next part is read without being asked
  const onScroll = () => {
    const el = scroller.current;
    if (!el || done) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 400) void more(next);
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <p className="shrink-0 px-4 pt-2 pb-1.5 text-2xs text-ink-muted leading-snug border-b border-line/50" data-large-readonly>
        {size === null ? t('surface.largeReadOnly') : fmt(t('surface.largeShown'), { shown: mb(next), size: mb(size) })}
        {restarted && <span className="ml-1 text-amber-700">{t('surface.largeRestarted')}</span>}
      </p>
      <div ref={scroller} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto nowheel" data-large-text>
        {failed ? <p className="px-4 py-3 text-xs text-red-600">{fmt(t('workspace.failed'), { why: failed })}</p> : (
          <div className={`px-4 py-2 text-xs text-ink leading-relaxed whitespace-pre-wrap break-words ${isProse(name) ? 'prose-text' : 'font-mono'}`}>
            {parts.map((part, index) => <span key={index} data-large-part>{part}</span>)}
          </div>
        )}
        {!failed && !done && size !== null && (
          <button onClick={() => void more(next)} data-large-more className="mx-4 my-2 px-2.5 py-1 rounded-md text-2xs text-ink bg-wash hover:bg-line/40 transition-colors">
            {t('surface.largeMore')}
          </button>
        )}
      </div>
    </div>
  );
}
