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
import { openEdit, saveEdit, type EditSession } from '../../lib/workspace/quick-edit';
import { useWorkspacePanel } from '../../lib/workspace/session';
import { useT, fmt } from '../../i18n';
import ContentNode from '../ContentNode';

// A node that stands for a real file in a workspace. It shows where the
// file is, whether it is still there, and the copy of its content that
// flows into context along its edge. Removing the node removes no file. A
// lost file shows a card for finding it again, never an empty body.

type Props = NodeProps<ThoughtNodeType>;
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ResourceNodeView(props: Props) {
  // far out, a file is material like any other: its icon
  return useZoomTier() === 'glyph' ? <ContentNode {...props} /> : <ResourceCard {...props} />;
}

/** `seen` is the revision the node's copy was at when the text was last read: a later one means the file changed elsewhere. */
type Editing = { session: EditSession; draft: string; seen: string | null; state: 'idle' | 'saving' | 'conflict'; current?: string | null };

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
  const [editing, setEditing] = useState<Editing | null>(null);
  const dirty = !!editing && editing.draft !== editing.session.loaded;

  // the file changed elsewhere while it is open here with nothing typed: show what it is now
  const revision = hint?.revision ?? null;
  useEffect(() => {
    if (!editing || editing.state !== 'idle' || !revision || revision === editing.seen || revision === editing.session.base || editing.draft !== editing.session.loaded) return;
    let stale = false;
    void openEdit(fileId).then((session) => { if (!stale) setEditing((now) => (now && now.draft === now.session.loaded ? { session, draft: session.loaded, seen: revision, state: 'idle' } : now)); }, () => {});
    return () => { stale = true; };
  }, [revision, editing, fileId]);

  const startEditing = async () => {
    try {
      const session = await openEdit(fileId);
      setEditing({ session, draft: session.loaded, seen: revision, state: 'idle' });
    } catch (e) {
      toast('error', fmt(t('workspace.failed'), { why: why(e) }));
    }
  };

  const save = async (against?: string) => {
    if (!editing || editing.state === 'saving') return;
    const { session, draft, seen } = editing;
    setEditing({ session, draft, seen, state: 'saving' });
    try {
      const { session: next, result } = await saveEdit(session, draft, against);
      // typing may have gone on while the save was out
      const latest = (now: Editing | null) => now?.draft ?? draft;
      if (result.status === 'saved') setEditing((now) => ({ session: next, draft: latest(now), seen, state: 'idle' }));
      else if (result.status === 'conflict') setEditing((now) => ({ session, draft: latest(now), seen, state: 'conflict', current: result.currentRevision }));
      else {
        setEditing((now) => ({ session, draft: latest(now), seen, state: 'idle' }));
        toast('error', fmt(t('resource.saveFailed'), { why: result.reason }));
      }
    } catch (e) {
      setEditing((now) => ({ session, draft: now?.draft ?? draft, seen, state: 'idle' }));
      toast('error', fmt(t('resource.saveFailed'), { why: why(e) }));
    }
  };

  const reload = async () => {
    try {
      const session = await openEdit(fileId);
      setEditing({ session, draft: session.loaded, seen: revision, state: 'idle' });
    } catch (e) {
      toast('error', fmt(t('workspace.failed'), { why: why(e) }));
    }
  };

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
              value={editing.draft}
              onChange={(e) => setEditing((now) => (now ? { ...now, draft: e.target.value } : now))}
              onKeyDown={(e) => {
                e.stopPropagation();
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
              }}
              spellCheck={false}
              data-resource-editor
              className="flex-1 min-h-[120px] w-full resize-none bg-wash border border-line rounded-md px-2 py-1.5 text-xs font-mono text-ink leading-relaxed outline-none focus:border-accent/60"
            />
            {editing.state === 'conflict' && (
              <div className="rounded-md bg-amber-50 border border-amber-200 px-2.5 py-2 text-2xs text-amber-800 leading-snug" data-resource-conflict>
                <p>{t(editing.current ? 'resource.conflict' : 'resource.conflictGone')}</p>
                <div className="flex gap-3 mt-1">
                  <button onClick={() => void reload()} className="underline hover:no-underline" data-conflict-reload>{t('resource.conflictReload')}</button>
                  {editing.current && <button onClick={() => void save(editing.current ?? undefined)} className="underline hover:no-underline" data-conflict-overwrite>{t('resource.conflictOverwrite')}</button>}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-ink-faint" data-resource-save-state>
                {editing.state === 'saving' ? t('resource.saving') : dirty ? t('resource.unsaved') : ''}
              </span>
              <span className="flex gap-1.5">
                <button onClick={() => void save()} disabled={!dirty || editing.state === 'saving'} data-resource-save
                  className={`${small} text-white bg-accent hover:opacity-90 disabled:opacity-40`}>{t('common.save')}</button>
                <button onClick={() => setEditing(null)} disabled={editing.state === 'saving'} data-resource-done
                  className={`${small} text-ink-muted hover:bg-wash`}>{t('common.done')}</button>
              </span>
            </div>
          </div>
        ) : !copy ? (
          <p className="text-2xs text-ink-faint leading-snug" data-resource-no-copy>{t('resource.noCopy')}</p>
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
