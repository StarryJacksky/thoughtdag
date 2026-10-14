import { useState } from 'react';
import { FileOutput, Sigma, Square } from 'lucide-react';
import { useT, fmt } from '../../i18n';
import { openFileSurface } from '../../lib/documents/surface-store';
import TextEditor from './TextEditor';
import RunPanel from './RunPanel';
import { useRun } from './use-run';

// A LaTeX source, typed as a source, with its formulas drawn where the
// cursor is not (see live-preview.ts). The drawing is turned on and off
// with the button or with Mod-Shift-M; the file is the same either way.
// "Compile" makes the PDF (with the TeX on this machine, else the engine
// the app brings) and opens it beside the source; compiled again, the
// reader that shows it shows the new one.

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
}

export default function TexEditor({ documentId, surfaceId, onSave }: Props) {
  const t = useT();
  const [drawn, setDrawn] = useState(true);
  const [panel, setPanel] = useState(false);
  // the PDF a compile made opens beside the source; a reader already showing it is brought forward and follows the file
  const { state, run, halt, clear, runnable } = useRun(documentId, (pdf) => { void openFileSurface(pdf, { placement: 'right' }).catch(() => {}); });
  const missing = state.tools?.missing ?? [];
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-end gap-0.5 px-2 py-1 border-b border-line/50">
        {missing.length > 0 && <span className="mr-auto text-2xs text-amber-700 truncate" data-code-missing>{fmt(t('run.missing'), { tools: missing.join(', ') })}</span>}
        {runnable && (state.status === 'running'
          ? <button onClick={halt} data-code-stop className="h-6 px-1.5 rounded flex items-center gap-1 text-2xs text-red-600 hover:bg-red-50 transition-colors"><Square size={11} strokeWidth={2} /> {t('run.stop')}</button>
          : <button onClick={() => { setPanel(true); void run(); }} disabled={missing.length > 0} data-code-run title={t('run.texTitle')}
            className="h-6 px-1.5 rounded flex items-center gap-1 text-2xs text-green-700 hover:bg-green-50 disabled:opacity-40 transition-colors">
            <FileOutput size={12} strokeWidth={1.75} /> {t('run.tex')}
          </button>)}
        <button onClick={() => setDrawn((on) => !on)} data-math-toggle aria-pressed={drawn} title={t('surface.texMathToggle')}
          className={`h-6 px-1.5 rounded flex items-center gap-1 text-2xs transition-colors ${drawn ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:text-ink hover:bg-wash'}`}>
          <Sigma size={12} strokeWidth={1.75} /> {t('surface.texMath')}
        </button>
      </div>
      <TextEditor documentId={documentId} surfaceId={surfaceId} onSave={onSave} preview={drawn} onTogglePreview={() => setDrawn((on) => !on)} />
      {panel && state.status !== 'idle' && <RunPanel state={state} onClear={clear} onClose={() => setPanel(false)} />}
    </div>
  );
}
