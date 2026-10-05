import { documents } from '../../lib/documents/document-service';
import { useDocument } from './use-document';
import { toast } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';

// What a surface shows of a document: its text, to type into, and where it
// stands with the file (saved, not saved, in conflict, could not be saved).
// The text is the document's; this view holds none of it and types straight
// into the shared buffer, so every other view of the file sees it at once.

interface Props {
  documentId: string;
  surfaceId: string;
}

export default function DocumentBody({ documentId, surfaceId }: Props) {
  const t = useT();
  const { model, status } = useDocument(documentId);
  if (!model) return null;
  const problem = status?.problem ?? null;

  const save = async () => {
    const result = await documents.save(documentId);
    if (result.status === 'error') toast('error', fmt(t('resource.saveFailed'), { why: result.reason }));
  };
  const blocked = model.state === 'clean' || model.state === 'saving' || model.state === 'readonly' || problem?.kind === 'conflict' || problem?.kind === 'lost';

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <textarea
        value={model.text}
        readOnly={model.state === 'readonly'}
        onChange={(e) => documents.setText(documentId, e.target.value, surfaceId)}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          const key = e.key.toLowerCase();
          if (mod && key === 's') { e.preventDefault(); void save(); }
          // undo and redo are the document's, shared by every view of the file
          else if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) documents.redo(documentId, surfaceId); else documents.undo(documentId, surfaceId); }
          else if (mod && key === 'y') { e.preventDefault(); documents.redo(documentId, surfaceId); }
        }}
        spellCheck={false}
        data-surface-text
        className="flex-1 min-h-0 w-full resize-none bg-card px-3 py-2 text-[13px] font-mono text-ink leading-relaxed outline-none"
      />
      {problem?.kind === 'conflict' && (
        <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-2 text-2xs text-amber-800 leading-snug" data-surface-conflict>
          <p>{t(problem.theirsRevision ? 'resource.conflict' : 'resource.conflictGone')}</p>
          {problem.theirsRevision && (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
              <button onClick={() => void documents.resolveConflict(documentId, 'theirs')} className="underline hover:no-underline" data-conflict-reload>{t('resource.conflictReload')}</button>
              <button onClick={() => void documents.resolveConflict(documentId, 'mine')} className="underline hover:no-underline" data-conflict-overwrite>{t('resource.conflictOverwrite')}</button>
              <button onClick={() => void documents.resolveConflict(documentId, 'both', { mine: t('resource.mine'), theirs: t('resource.theirs') })} className="underline hover:no-underline" data-conflict-both>{t('resource.conflictBoth')}</button>
            </div>
          )}
        </div>
      )}
      <div className="shrink-0 flex items-center justify-between gap-2 border-t border-line/70 px-3 py-1.5">
        <span className={`text-2xs truncate ${problem?.kind === 'error' ? 'text-red-600' : problem?.kind === 'lost' ? 'text-amber-800' : 'text-ink-faint'}`} data-surface-state={model.state}>
          {problem?.kind === 'error' ? fmt(t('resource.saveFailed'), { why: problem.reason })
            : problem?.kind === 'lost' ? t('resource.conflictGone')
              : model.state === 'saving' ? t('resource.saving')
                : model.state === 'dirty' ? t(status?.restoredFromDraft ? 'resource.restoredDraft' : 'resource.unsaved')
                  : model.state === 'clean' ? t('resource.saved')
                    : model.state === 'readonly' ? t('workspace.readOnly') : ''}
        </span>
        <button onClick={() => void save()} disabled={blocked} data-surface-save
          className="shrink-0 px-2 py-1 rounded-md text-2xs text-white bg-accent hover:opacity-90 disabled:opacity-40 transition-opacity">
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
