import { useState } from 'react';
import { BookOpen, Code2, FileDown, Loader2, PenLine } from 'lucide-react';
import { Markdown } from '../Markdown';
import { useDocument } from '../surfaces/use-document';
import { useT, fmt } from '../../i18n';
import { documents } from '../../lib/documents/document-service';
import { openBeside } from '../../lib/documents/surface-store';
import { exportBeside } from '../../lib/workspace/client';
import { toast } from '../../lib/ui-store';
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
//
// It can be made into a Word document beside it (lib/docx/write.ts), its
// formulas Word's own: what is typed is saved first, the document is a new
// file every time (never over one someone may have worked on in Word), and
// it opens to read on the right.

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
}

type Mode = 'live' | 'source' | 'reading';

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function MarkdownEditor({ documentId, surfaceId, onSave }: Props) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('live');
  const [exporting, setExporting] = useState(false);
  const { model } = useDocument(documentId);
  const toWord = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      // what is made is what is typed, saved: a document made from text that is not in the file would say what the file does not
      const saved = await documents.save(documentId);
      const now = documents.get(documentId);
      if (saved.status !== 'saved' || !now) { toast('error', t('surface.exportNotSaved')); return; }
      const { markdownToDocx } = await import('../../lib/docx/write');
      const name = documents.status(documentId)?.name ?? '';
      const bytes = await markdownToDocx(now.text, { title: name.replace(/\.[^.]+$/, '') });
      const made = await exportBeside(now.fileId, 'docx', bytes);
      await openBeside(surfaceId, made.fileId);
      toast('success', fmt(t('surface.exportedDocx'), { name: made.relativePath ?? '' }), 6000);
    } catch (e) {
      toast('error', fmt(t('workspace.failed'), { why: why(e) }));
    } finally {
      setExporting(false);
    }
  };
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
        <span className="w-px h-4 bg-line mx-1" />
        <button onClick={() => void toWord()} disabled={exporting} title={t('surface.mdExportDocx')} data-markdown-export="docx"
          className="h-6 px-1.5 rounded flex items-center gap-1 text-2xs text-ink-faint hover:text-ink hover:bg-wash disabled:opacity-50 transition-colors">
          {exporting ? <Loader2 size={12} strokeWidth={1.75} className="animate-spin" /> : <FileDown size={12} strokeWidth={1.75} />} Word
        </button>
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
