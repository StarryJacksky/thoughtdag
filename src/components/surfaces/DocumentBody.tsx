import { useState } from 'react';
import { GitCompareArrows, History } from 'lucide-react';
import { documents } from '../../lib/documents/document-service';
import { useDocument } from './use-document';
import MarkdownEditor from '../editors/MarkdownEditor';
import TexEditor from '../editors/TexEditor';
import CodeEditor from '../editors/CodeEditor';
import { isProse } from '../editors/codemirror-document';
import TextEditor from '../editors/TextEditor';
import { toast } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';
import VersionsPanel, { ConflictCompare } from './VersionsPanel';

// What a surface shows of a document: its text in an editor, to type into,
// and where it stands with the file (saved, not saved, in conflict, could
// not be saved). The text is the document's; the editor is one view of it
// and types straight into the shared buffer, so every other view of the
// file sees it at once.

interface Props {
  documentId: string;
  surfaceId: string;
  /** how the document is shown: Markdown gets a preview beside its text */
  kind: 'text' | 'markdown';
}

export default function DocumentBody({ documentId, surfaceId, kind }: Props) {
  const t = useT();
  const { model, status } = useDocument(documentId);
  // what the file held before each save, and the two sides of a conflict line by line: shown when asked for
  const [history, setHistory] = useState(false);
  const [comparing, setComparing] = useState(false);
  if (!model) return null;
  const problem = status?.problem ?? null;

  const save = async () => {
    const result = await documents.save(documentId);
    if (result.status === 'error') toast('error', fmt(t('resource.saveFailed'), { why: result.reason }));
  };
  const blocked = model.state === 'clean' || model.state === 'saving' || model.state === 'readonly' || problem?.kind === 'conflict' || problem?.kind === 'lost';

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {kind === 'markdown'
        ? <MarkdownEditor documentId={documentId} surfaceId={surfaceId} onSave={() => void save()} />
        : /\.(tex|ltx)$/i.test(status?.name ?? '')
          ? <TexEditor documentId={documentId} surfaceId={surfaceId} onSave={() => void save()} />
          : !isProse(status?.name ?? '')
            ? <CodeEditor documentId={documentId} surfaceId={surfaceId} onSave={() => void save()} />
            : <TextEditor documentId={documentId} surfaceId={surfaceId} onSave={() => void save()} />}
      {problem?.kind === 'conflict' && (
        <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-2 text-2xs text-amber-800 leading-snug" data-surface-conflict>
          <p>{t(problem.theirsRevision ? 'resource.conflict' : 'resource.conflictGone')}</p>
          {problem.theirsText !== null && comparing && <ConflictCompare mine={model.text} theirs={problem.theirsText} />}
          {problem.theirsRevision && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
              <button onClick={() => void documents.resolveConflict(documentId, 'theirs')} className="underline hover:no-underline" data-conflict-reload>{t('resource.conflictReload')}</button>
              <button onClick={() => void documents.resolveConflict(documentId, 'mine')} className="underline hover:no-underline" data-conflict-overwrite>{t('resource.conflictOverwrite')}</button>
              <button onClick={() => void documents.resolveConflict(documentId, 'both', { mine: t('resource.mine'), theirs: t('resource.theirs') })} className="underline hover:no-underline" data-conflict-both>{t('resource.conflictBoth')}</button>
              {problem.theirsText !== null && (
                <button onClick={() => setComparing((on) => !on)} className="flex items-center gap-1 underline hover:no-underline" data-conflict-compare>
                  <GitCompareArrows size={11} strokeWidth={1.75} /> {t(comparing ? 'versions.compareHide' : 'versions.compare')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {history && <VersionsPanel documentId={documentId} />}
      <div className="shrink-0 flex items-center justify-between gap-2 border-t border-line/70 px-3 py-1.5">
        <span className={`text-2xs truncate ${problem?.kind === 'error' ? 'text-red-600' : problem?.kind === 'lost' ? 'text-amber-800' : 'text-ink-faint'}`} data-surface-state={model.state}>
          {problem?.kind === 'error' ? fmt(t('resource.saveFailed'), { why: problem.reason })
            : problem?.kind === 'lost' ? t('resource.conflictGone')
              : model.state === 'saving' ? t('resource.saving')
                : model.state === 'dirty' ? t(status?.restoredFromDraft ? 'resource.restoredDraft' : 'resource.unsaved')
                  : model.state === 'clean' ? t('resource.saved')
                    : model.state === 'readonly' ? t('workspace.readOnly') : ''}
        </span>
        <button onClick={() => setHistory((on) => !on)} data-versions-toggle={history ? 'open' : 'closed'} title={t('versions.title')}
          className={`shrink-0 w-6 h-6 rounded flex items-center justify-center transition-colors ${history ? 'text-accent bg-accent/10' : 'text-ink-faint hover:text-ink hover:bg-wash'}`}>
          <History size={13} strokeWidth={1.75} />
        </button>
        <button onClick={() => void save()} disabled={blocked} data-surface-save
          className="shrink-0 px-2 py-1 rounded-md text-2xs text-white bg-accent hover:opacity-90 disabled:opacity-40 transition-opacity">
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
