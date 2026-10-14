import { useState } from 'react';
import { BookOpen, Code2, PenLine } from 'lucide-react';
import { Markdown } from '../Markdown';
import { useDocument } from '../surfaces/use-document';
import { useT } from '../../i18n';
import TextEditor from './TextEditor';

// A Markdown document, the way a notes app shows one. By default it is
// written in place, laid out as it reads: headings large, bold bold,
// formulas drawn, and the markup showing only where the cursor is (see
// live-preview.ts). It can also be shown as its plain source, or as the
// page it reads as, with nothing to type into. Whichever way it is shown,
// the file holds exactly what was typed.
//
// The page goes through the same sanitizing renderer as every answer on
// the canvas, so markup in the file is shown and never run.

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
}

type Mode = 'live' | 'source' | 'reading';

export default function MarkdownEditor({ documentId, surfaceId, onSave }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('live');
  const { model } = useDocument(documentId);
  const tab = (value: Mode, title: string, icon: React.ReactNode) => (
    <button onClick={() => setMode(value)} title={title} data-markdown-mode={value} aria-pressed={mode === value}
      className={`h-6 px-1.5 rounded flex items-center gap-1 text-2xs transition-colors ${mode === value ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:text-ink hover:bg-wash'}`}>
      {icon}
    </button>
  );
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-end gap-0.5 px-2 py-1 border-b border-line/50">
        {tab('live', t('surface.mdLive'), <PenLine size={12} strokeWidth={1.75} />)}
        {tab('source', t('surface.mdSource'), <Code2 size={12} strokeWidth={1.75} />)}
        {tab('reading', t('surface.mdReading'), <BookOpen size={12} strokeWidth={1.75} />)}
      </div>
      <div className="flex flex-1 min-h-0">
        {mode === 'reading'
          ? model && (
            <div className="flex-1 min-w-0 overflow-y-auto" data-markdown-preview>
              <div className="markdown-body note-page">
                <Markdown>{model.text}</Markdown>
              </div>
            </div>
          )
          : <TextEditor documentId={documentId} surfaceId={surfaceId} onSave={onSave} preview={mode === 'live'} onTogglePreview={() => setMode((m) => (m === 'live' ? 'source' : 'live'))} />}
      </div>
    </div>
  );
}
