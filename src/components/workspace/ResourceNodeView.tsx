import { useEffect, useState } from 'react';
import { Handle, NodeResizeControl, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AlertTriangle, BookOpen, FileText, FolderOpen, Link2Off, MoveDiagonal2, Pencil, Trash2 } from 'lucide-react';
import type { ThoughtNode as ThoughtNodeType } from '../../types';
import { useStore } from '../../store';
import { useZoomTier } from '../../lib/use-map-mode';
import { toast, useUiStore } from '../../lib/ui-store';
import { isViewerMode } from '../../lib/viewer';
import { revealFile, workspaceAvailable } from '../../lib/workspace/client';
import { isEditableText } from '../../lib/workspace/file-types';
import { RESOURCE_DRAG_TYPE, type DragPayload } from '../../lib/workspace/graph-resource';
import { documents, type DocumentStatus } from '../../lib/documents/document-service';
import type { DocumentModel } from '../../lib/workspace/contracts';
import { useWorkspacePanel } from '../../lib/workspace/session';
import { useT, fmt } from '../../i18n';
import ContentNode from '../ContentNode';

// A node that stands for a real file in a workspace. It shows where the
// file is, whether it is still there, and the copy of its content that
// flows into context along its edge. Removing the node removes no file. A
// lost file shows a card for finding it again, never an empty body.
//
// Typing into the file from the node is one view of the file's document
// (lib/documents): the same buffer every other view of that file shows.
// The node holds none of the text being typed.

type Props = NodeProps<ThoughtNodeType>;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ResourceNodeView(props: Props) {
  // far out, a file is material like any other: its icon
  return useZoomTier() === 'glyph' ? <ContentNode {...props} /> : <ResourceCard {...props} />;
}

function ResourceCard({ id, data, selected }: Props) {
  const t = useT();
  const deleteNode = useStore((s) => s.deleteNode);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  // on the canvas is not in context: the card says which of the two it is
  const wireState = useStore((s) => {
    const outs = s.edges.filter((e) => e.source === id);
    if (outs.length === 0) return 'none:0';
    const full = outs.filter((e) => !e.data?.isCrossLink).length;
    return full > 0 ? `full:${full}` : 'quote:0';
  });
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, updateNodeInternals]);

  const hint = data.resourceHint;
  const fileId = data.resourceRef?.fileId ?? '';
  const copy = data.attachments?.[0];
  const lost = hint?.status === 'missing' || hint?.status === 'ambiguous';
  const canEdit = !isViewerMode && hint?.status === 'ready' && !!copy && isEditableText(hint.name) && workspaceAvailable();
  // the document being typed into from this node, while it is; the text lives in the document service
  const surfaceId = `node:${id}`;
  const [editing, setEditing] = useState<DocumentModel | null>(null);
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const documentId = editing?.documentId ?? null;
  useEffect(() => {
    if (!documentId) return;
    return documents.subscribe(documentId, (model) => { setEditing(model); setStatus(documents.status(model.documentId) ?? null); });
  }, [documentId]);
  // the node going away closes its view; what was typed is saved or kept as a draft by the service
  useEffect(() => () => { void documents.closeView(surfaceId); }, [surfaceId]);
  const revision = hint?.revision ?? null;

  const startEditing = async () => {
    try {
      const model = await documents.open(fileId, surfaceId);
      setEditing(model);
      setStatus(documents.status(model.documentId) ?? null);
    } catch (e) {
      toast('error', fmt(t('workspace.failed'), { why: why(e) }));
    }
  };
  const stopEditing = () => {
    setEditing(null);
    setStatus(null);
    void documents.closeView(surfaceId);
  };
  const save = async () => {
    if (!editing) return;
    const result = await documents.save(editing.documentId);
    if (result.status === 'error') toast('error', fmt(t('resource.saveFailed'), { why: result.reason }));
  };
  const problem = status?.problem ?? null;

  const isImage = !!copy && copy.type.startsWith('image/');
  const text = copy && !isImage && copy.type !== 'application/pdf' ? (copy.extractedText ?? copy.content) : '';
  const action = 'text-ink-faint hover:text-accent rounded-full w-6 h-6 flex items-center justify-center transition-colors';
  const small = 'px-2 py-1 rounded-md text-2xs transition-colors';

  return (
    <div
      className={`content-card w-full h-full min-w-[340px] flex flex-col rounded-xl shadow-sm border-2 bg-card animate-fade-in transition-colors duration-200 ${
        lost ? 'border-amber-300' : 'border-line'
      } ${selectedNodeId === id ? 'ring-2 ring-accent selected-glow' : ''}`}
      onClick={() => setSelectedNodeId(id)}
      onDoubleClick={() => { if (!editing && copy) useUiStore.getState().setReaderNodeId(id); }}
      data-resource-node={hint?.status ?? 'ready'}
    >
      {/* Pure source, like every piece of material: nothing flows INTO it, so no target handle. */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-line/70 cursor-grab active:cursor-grabbing drag-handle shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} strokeWidth={1.75} className="text-ink-muted shrink-0" />
          <span className="text-xs text-ink font-medium truncate" data-resource-name>{hint?.name}</span>
          {hint?.imported && <span className="text-2xs text-ink-muted bg-wash px-1.5 py-0.5 rounded-full shrink-0" data-resource-copy>{t('resource.copyBadge')}</span>}
          {hint?.status === 'readonly' && <span className="text-2xs text-ink-faint bg-wash px-1.5 py-0.5 rounded-full shrink-0">{t('workspace.readOnly')}</span>}
          {wireState === 'none:0' && (
            <span className="text-2xs text-ink-faint bg-wash px-1.5 py-0.5 rounded-full flex items-center gap-1 shrink-0" title={t('content.unlinkedTitle')}>
              <Link2Off size={11} strokeWidth={1.75} /> {t('content.unlinked')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 nodrag">
          {canEdit && !editing && (
            <button onClick={(e) => { e.stopPropagation(); void startEditing(); }} title={t('resource.edit')} className={action} data-resource-edit><Pencil size={13} strokeWidth={1.75} /></button>
          )}
          {copy && !editing && (
            <button onClick={(e) => { e.stopPropagation(); useUiStore.getState().setReaderNodeId(id); }} title={t('reader.open')} className={action}><BookOpen size={13} strokeWidth={1.75} /></button>
          )}
          {!lost && workspaceAvailable() && (
            <button onClick={(e) => { e.stopPropagation(); void revealFile(fileId).catch((err) => toast('error', fmt(t('workspace.failed'), { why: why(err) }))); }} title={t('workspace.reveal')} className={action} data-resource-reveal>
              <FolderOpen size={13} strokeWidth={1.75} />
            </button>
          )}
          {!isViewerMode && (
            <button onClick={(e) => { e.stopPropagation(); deleteNode(id); }} title={t('resource.deleteNodeTitle')} className="text-ink-faint hover:text-red-500 rounded-full w-6 h-6 flex items-center justify-center transition-colors" data-resource-remove>
              <Trash2 size={13} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      {/* where the file is: shown, and draggable onto a folder of the file panel to move the file there */}
      <div className="px-4 pt-2 shrink-0 nodrag">
        <span
          draggable={!lost && !isViewerMode}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData(RESOURCE_DRAG_TYPE, JSON.stringify({ kind: 'graph-node', nodeId: id } satisfies DragPayload));
            e.dataTransfer.effectAllowed = 'copyMove';
          }}
          title={lost ? undefined : t('resource.moveHint')}
          data-resource-path
          className={`inline-block max-w-full truncate align-bottom text-2xs font-mono px-1.5 py-0.5 rounded bg-wash ${lost ? 'text-ink-faint line-through' : 'text-ink-muted cursor-grab'}`}
        >
          {hint?.relativePath ?? hint?.name}
        </span>
      </div>

      <div className="px-4 py-2 nodrag flex-1 min-h-0 overflow-y-auto nowheel flex flex-col">
        {lost ? (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5" data-resource-lost>
            <p className="text-xs text-amber-800 font-medium flex items-center gap-1.5">
              <AlertTriangle size={13} strokeWidth={1.75} className="shrink-0" />
              {t(hint?.status === 'ambiguous' ? 'resource.ambiguous' : 'resource.missing')}
            </p>
            <p className="text-2xs text-amber-800/80 leading-snug mt-1">{fmt(t('resource.missingHint'), { path: hint?.relativePath ?? hint?.name ?? '' })}</p>
            {!isViewerMode && workspaceAvailable() && (
              <button onClick={(e) => { e.stopPropagation(); useWorkspacePanel.setState({ open: true, relinkNodeId: id }); }} data-resource-relink
                className="mt-2 px-2.5 py-1 rounded-md text-2xs text-amber-900 bg-amber-200/70 hover:bg-amber-200 transition-colors">
                {t('resource.relink')}
              </button>
            )}
          </div>
        ) : editing ? (
          <div className="flex flex-col flex-1 min-h-[160px] gap-1.5" onDoubleClick={(e) => e.stopPropagation()}>
            <textarea
              autoFocus
              value={editing.text}
              readOnly={editing.state === 'readonly'}
              onChange={(e) => documents.setText(editing.documentId, e.target.value, surfaceId)}
              onKeyDown={(e) => {
                e.stopPropagation();
                const mod = e.metaKey || e.ctrlKey;
                const key = e.key.toLowerCase();
                if (mod && key === 's') { e.preventDefault(); void save(); }
                // undo and redo are the document's, shared by every view of the file
                else if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) documents.redo(editing.documentId, surfaceId); else documents.undo(editing.documentId, surfaceId); }
                else if (mod && key === 'y') { e.preventDefault(); documents.redo(editing.documentId, surfaceId); }
              }}
              spellCheck={false}
              data-resource-editor
              className="flex-1 min-h-[120px] w-full resize-none bg-wash border border-line rounded-md px-2 py-1.5 text-xs font-mono text-ink leading-relaxed outline-none focus:border-accent/60"
            />
            {problem?.kind === 'conflict' && (
              <div className="rounded-md bg-amber-50 border border-amber-200 px-2.5 py-2 text-2xs text-amber-800 leading-snug" data-resource-conflict>
                <p>{t(problem.theirsRevision ? 'resource.conflict' : 'resource.conflictGone')}</p>
                {problem.theirsRevision && (
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
                    <button onClick={() => void documents.resolveConflict(editing.documentId, 'theirs')} className="underline hover:no-underline" data-conflict-reload>{t('resource.conflictReload')}</button>
                    <button onClick={() => void documents.resolveConflict(editing.documentId, 'mine')} className="underline hover:no-underline" data-conflict-overwrite>{t('resource.conflictOverwrite')}</button>
                    <button onClick={() => void documents.resolveConflict(editing.documentId, 'both', { mine: t('resource.mine'), theirs: t('resource.theirs') })} className="underline hover:no-underline" data-conflict-both>{t('resource.conflictBoth')}</button>
                  </div>
                )}
              </div>
            )}
            {problem?.kind === 'lost' && <p className="text-2xs text-amber-800 leading-snug" data-resource-edit-lost>{t('resource.conflictGone')}</p>}
            {problem?.kind === 'error' && <p className="text-2xs text-red-600 leading-snug" data-resource-edit-error>{fmt(t('resource.saveFailed'), { why: problem.reason })}</p>}
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-ink-faint" data-resource-save-state={editing.state}>
                {editing.state === 'saving' ? t('resource.saving')
                  : editing.state === 'dirty' ? t(status?.restoredFromDraft ? 'resource.restoredDraft' : 'resource.unsaved')
                    : editing.state === 'clean' ? t('resource.saved')
                      : editing.state === 'readonly' ? t('workspace.readOnly') : ''}
              </span>
              <span className="flex gap-1.5">
                <button onClick={() => void save()} disabled={editing.state === 'clean' || editing.state === 'saving' || editing.state === 'readonly' || problem?.kind === 'conflict' || problem?.kind === 'lost'} data-resource-save
                  className={`${small} text-white bg-accent hover:opacity-90 disabled:opacity-40`}>{t('common.save')}</button>
                <button onClick={stopEditing} data-resource-done
                  className={`${small} text-ink-muted hover:bg-wash`}>{t('common.done')}</button>
              </span>
            </div>
          </div>
        ) : !copy && !hint?.uncopied && revision === null ? (
          // the file has not been read yet: its copy is on its way
          <p className="text-2xs text-ink-faint" data-resource-reading>{t('workspace.loading')}</p>
        ) : !copy ? (
          <p className="text-2xs text-ink-faint leading-snug" data-resource-no-copy={hint?.uncopied ?? 'unknown'}>
            {t(hint?.uncopied === 'too-large' ? 'resource.noCopyLarge' : hint?.uncopied === 'unreadable' ? 'resource.noCopyKind' : 'resource.noCopy')}
          </p>
        ) : isImage ? (
          <img src={copy.thumbnailUrl} alt={copy.name} className="max-w-full rounded-md" draggable={false} />
        ) : copy.isExtracting ? (
          <p className="text-2xs text-accent">{t('attach.extracting')}</p>
        ) : text === '' ? (
          <p className="text-2xs text-ink-faint" data-resource-empty>{copy.type === 'application/pdf' ? copy.name : t('resource.empty')}</p>
        ) : (
          <pre className="text-xs font-mono text-ink-muted leading-relaxed whitespace-pre-wrap break-words" data-resource-preview>{text.length > 4000 ? `${text.slice(0, 4000)}…` : text}</pre>
        )}
      </div>

      <div className="px-4 pb-2 shrink-0" data-wire-status>
        {wireState === 'none:0' ? (
          <p className="text-2xs text-amber-700 leading-snug">{t('content.wireNone')}</p>
        ) : wireState === 'quote:0' ? (
          <p className="text-2xs text-amber-700 leading-snug">{t('content.wireQuoteOnly')}</p>
        ) : (
          <p className="text-2xs text-ink-faint leading-snug">{fmt(t('content.wireFull'), { n: wireState.split(':')[1] })}</p>
        )}
      </div>

      {selected && (
        <NodeResizeControl position="bottom-right" minWidth={320} maxWidth={860} minHeight={160} style={{ background: 'transparent', border: 'none', width: 18, height: 18 }}>
          <MoveDiagonal2 size={13} strokeWidth={1.75} className="text-ink-faint absolute bottom-0.5 right-0.5" />
        </NodeResizeControl>
      )}

      <Handle type="source" position={Position.Bottom} id="continue" className="!bg-ink-faint !border-2 !border-white tdag-handle !w-3.5 !h-3.5" />
      {/* the same invisible side anchor other material has, so references can leave sideways */}
      <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '50%' }} />
    </div>
  );
}
