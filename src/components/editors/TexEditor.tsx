import { useState } from 'react';
import { Sigma } from 'lucide-react';
import { useT } from '../../i18n';
import TextEditor from './TextEditor';

// A LaTeX source, typed as a source, with its formulas drawn where the
// cursor is not (see live-preview.ts). The drawing is turned on and off
// with the button or with Mod-Shift-M; the file is the same either way.

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
}

export default function TexEditor({ documentId, surfaceId, onSave }: Props) {
  const t = useT();
  const [drawn, setDrawn] = useState(true);
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-end gap-0.5 px-2 py-1 border-b border-line/50">
        <button onClick={() => setDrawn((on) => !on)} data-math-toggle aria-pressed={drawn} title={t('surface.texMathToggle')}
          className={`h-6 px-1.5 rounded flex items-center gap-1 text-2xs transition-colors ${drawn ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:text-ink hover:bg-wash'}`}>
          <Sigma size={12} strokeWidth={1.75} /> {t('surface.texMath')}
        </button>
      </div>
      <TextEditor documentId={documentId} surfaceId={surfaceId} onSave={onSave} preview={drawn} onTogglePreview={() => setDrawn((on) => !on)} />
    </div>
  );
}
