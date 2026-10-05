import { useState } from 'react';
import { Columns2, Eye, Pencil } from 'lucide-react';
import { Markdown } from '../Markdown';
import { useDocument } from '../surfaces/use-document';
import { useT } from '../../i18n';
import TextEditor from './TextEditor';

// A Markdown document: the text to type into, the same text as it reads,
// or both side by side. The preview is the buffer rendered, so it shows
// what is typed as it is typed; it goes through the same sanitizing
// renderer as every answer on the canvas, so markup in the file is shown
// and never run.

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
}

type Mode = 'edit' | 'split' | 'preview';

export default function MarkdownEditor({ documentId, surfaceId, onSave }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('edit');
  const { model } = useDocument(documentId);
  const tab = (value: Mode, title: string, icon: React.ReactNode) => (
    <button onClick={() => setMode(value)} title={title} data-markdown-mode={value}
      className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${mode === value ? 'bg-accent/10 text-accent' : 'text-ink-faint hover:text-ink hover:bg-wash'}`}>
      {icon}
    </button>
  );
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-end gap-0.5 px-2 py-1 border-b border-line/50">
        {tab('edit', t('surface.mdEdit'), <Pencil size={12} strokeWidth={1.75} />)}
        {tab('split', t('surface.mdSplit'), <Columns2 size={12} strokeWidth={1.75} />)}
        {tab('preview', t('surface.mdPreview'), <Eye size={12} strokeWidth={1.75} />)}
      </div>
      <div className="flex flex-1 min-h-0">
        {mode !== 'preview' && <TextEditor documentId={documentId} surfaceId={surfaceId} onSave={onSave} />}
        {mode !== 'edit' && model && (
          <div className={`flex-1 min-w-0 overflow-y-auto px-4 py-3 text-sm text-ink leading-relaxed ${mode === 'split' ? 'border-l border-line/50' : ''}`} data-markdown-preview>
            <Markdown>{model.text}</Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
