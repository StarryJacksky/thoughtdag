import { useEffect, useRef } from 'react';
import { Eraser, X } from 'lucide-react';
import type { RunState } from './use-run';
import { useT, fmt } from '../../i18n';

// What a run printed, under the code: the command, its output with its
// errors set apart, and how it ended. It follows the newest line unless
// the person has scrolled up to read.

export default function RunPanel({ state, onClear, onClose }: { state: RunState; onClear: () => void; onClose: () => void }) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => { const el = body.current; if (el && following.current) el.scrollTop = el.scrollHeight; }, [state.lines.length]);
  const ended = state.status !== 'running' && state.status !== 'idle';
  const tone = state.status === 'ok' ? 'text-green-700' : state.status === 'running' ? 'text-accent' : state.status === 'stopped' ? 'text-ink-muted' : 'text-red-600';
  return (
    <div className="shrink-0 h-[38%] min-h-[110px] flex flex-col border-t border-line bg-wash/60" data-run-output>
      <div className="shrink-0 flex items-center gap-2 px-3 py-1 border-b border-line/60 text-2xs">
        <span className="font-medium text-ink">{t('run.output')}</span>
        <span className="flex-1 min-w-0 truncate font-mono text-ink-faint" data-run-command>{state.command}</span>
        <span className={tone} data-run-status={state.status}>
          {state.status === 'running' ? t('run.running')
            : ended ? fmt(t(`run.status.${state.status as 'ok' | 'failed' | 'stopped' | 'unavailable'}`), { code: state.code ?? '-', s: ((state.ms ?? 0) / 1000).toFixed(1) }) : ''}
        </span>
        <button onClick={onClear} title={t('run.clear')} className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-line/40"><Eraser size={11} strokeWidth={1.75} /></button>
        <button onClick={onClose} title={t('run.hide')} className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-line/40" data-run-hide><X size={12} strokeWidth={1.75} /></button>
      </div>
      <div ref={body} onScroll={(e) => { const el = e.currentTarget; following.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8; }}
        className="flex-1 min-h-0 overflow-auto px-3 py-1.5 font-mono text-[12px] leading-snug whitespace-pre-wrap break-words nowheel">
        {state.lines.map((line, index) => (
          <span key={index} data-run-stream={line.stream} className={line.stream === 'stderr' ? 'text-red-600' : line.stream === 'note' ? 'text-ink-faint' : 'text-ink'}>{line.text}</span>
        ))}
      </div>
    </div>
  );
}
