import { Fragment, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ClipboardPaste, File as FileIcon, FilePlus, Folder, FolderOpen, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import { listChildren, moveFile, newOperationId, registerEntry, revealFile, trashFile, workspaceAvailable } from '../../lib/workspace/client';
import type { FileEntry } from '../../lib/workspace/contracts';
import { createDocument } from '../../lib/workspace/create-command';
import { RESOURCE_DRAG_TYPE, applyRecord, attachEntry, copyAcrossWorkspaces, moveReferencedFile, parseDragPayload, relinkNode, type DragPayload } from '../../lib/workspace/graph-resource';
import { openCanvasFolder, pickWorkspaceFolder, reloadTree, useWorkspacePanel } from '../../lib/workspace/session';
import { confirmDialog, toast } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';
import CreateFileMenu from './CreateFileMenu';
import ImportCopyDialog from './ImportCopyDialog';

// The file panel: the folder the open canvas works in, as a tree. Files are
// named here by the ids the shell gave them; a path is only ever shown.
// What a drag carries out of here, and what may be dropped in, is a
// structured payload of ids (lib/workspace/graph-resource).

type Listing = FileEntry[] | 'loading' | { error: string };
const ROOT = '';
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Mounted anew for each workspace (the caller keys it by the workspace's
// id), so nothing of one folder's tree carries over to another's.
interface Props {
  /** where on the canvas a file added from here should go */
  placeAt: () => { x: number; y: number };
}

export default function WorkspaceExplorer({ placeAt }: Props) {
  const t = useT();
  const workspace = useWorkspacePanel((s) => s.workspace);
  const treeVersion = useWorkspacePanel((s) => s.treeVersion);
  const relinkNodeId = useWorkspacePanel((s) => s.relinkNodeId);
  const relinkName = useStore((s) => (relinkNodeId ? s.nodes.find((n) => n.id === relinkNodeId)?.data.resourceHint?.name ?? null : null));
  const workspaceId = workspace?.workspaceId ?? null;

  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [folder, setFolder] = useState<FileEntry | null>(null); // where a new file goes; null is the top
  const [menu, setMenu] = useState<null | 'open' | 'create'>(null);
  const [createAt, setCreateAt] = useState({ left: 0, top: 0 });
  const [importing, setImporting] = useState<null | 'chatgpt-space' | 'other'>(null);
  const [spaceNotice, setSpaceNotice] = useState(false);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const expandedNow = useRef(expanded);
  useEffect(() => { expandedNow.current = expanded; }, [expanded]);

  // read the top and every open folder again whenever something says the tree changed
  useEffect(() => {
    if (!workspaceId) return;
    let stale = false;
    const timer = setTimeout(() => {
      for (const key of [ROOT, ...expandedNow.current]) {
        listChildren(workspaceId, key || undefined).then(
          (entries) => { if (!stale) setListings((l) => ({ ...l, [key]: entries })); },
          (e) => { if (!stale) setListings((l) => ({ ...l, [key]: { error: why(e) } })); },
        );
      }
    }, 60);
    return () => { stale = true; clearTimeout(timer); };
  }, [workspaceId, treeVersion]);

  const attempt = async (work: () => Promise<void>) => {
    try { await work(); } catch (e) { toast('error', fmt(t('workspace.failed'), { why: why(e) })); }
  };

  const toggle = (entry: FileEntry) => {
    setFolder(entry);
    const open = !expanded.has(entry.entryId);
    setExpanded((prev) => { const next = new Set(prev); if (open) next.add(entry.entryId); else next.delete(entry.entryId); return next; });
    if (open && workspaceId) {
      setListings((l) => (l[entry.entryId] ? l : { ...l, [entry.entryId]: 'loading' }));
      listChildren(workspaceId, entry.entryId).then(
        (entries) => setListings((l) => ({ ...l, [entry.entryId]: entries })),
        (e) => setListings((l) => ({ ...l, [entry.entryId]: { error: why(e) } })),
      );
    }
  };

  const create = (extension: string) => attempt(async () => {
    setMenu(null);
    if (!workspaceId) return;
    const made = await createDocument({ workspaceId, ...(folder ? { parentId: folder.entryId } : {}), extension, origin: 'workspace' });
    if (folder) setExpanded((prev) => new Set(prev).add(folder.entryId));
    reloadTree();
    toast('success', fmt(t('workspace.created'), { name: made.record.relativePath ?? '' }), 5000, { label: t('workspace.reveal'), run: () => void revealFile(made.record.fileId).catch(() => {}) });
  });

  const addToCanvas = (entry: FileEntry) => attempt(async () => {
    const canvasId = useProjects.getState().activeId;
    if (!workspaceId || !canvasId) return;
    await attachEntry(canvasId, workspaceId, entry.entryId, placeAt());
  });

  const reveal = (entry: FileEntry) => attempt(async () => {
    if (!workspaceId) return;
    await revealFile((await registerEntry(workspaceId, entry.entryId)).fileId);
  });

  const trash = (entry: FileEntry) => attempt(async () => {
    if (!workspaceId) return;
    const ok = await confirmDialog({ message: fmt(t('workspace.trashConfirm'), { name: entry.name }), confirmLabel: t('workspace.trash'), danger: true });
    if (!ok) return;
    await trashFile((await registerEntry(workspaceId, entry.entryId)).fileId, newOperationId());
    reloadTree();
  });

  const relink = (entry: FileEntry) => attempt(async () => {
    if (!relinkNodeId) return;
    const record = await relinkNode(relinkNodeId, entry.entryId);
    useWorkspacePanel.setState({ relinkNodeId: null });
    reloadTree();
    toast('success', fmt(t('resource.relinked'), { name: record.relativePath ?? entry.name }));
  });

  /** A file or a graph node dropped on a folder (null is the top): moved when it is in this workspace, copied in when it is in another. */
  const dropInto = (target: FileEntry | null, payload: DragPayload) => attempt(async () => {
    if (!workspaceId || payload.kind === 'selection-ref') return;
    const parentId = target?.entryId;
    if (payload.kind === 'graph-node') {
      const data = useStore.getState().nodes.find((n) => n.id === payload.nodeId)?.data;
      if (!data?.resourceRef || !data.resourceHint) return;
      if (data.resourceHint.workspaceId === workspaceId) {
        const moved = await moveReferencedFile(payload.nodeId, parentId);
        toast('success', fmt(t('workspace.moved'), { path: moved.relativePath ?? '' }));
      } else {
        const copy = await copyAcrossWorkspaces(data.resourceRef.fileId, data.resourceHint.name, { workspaceId, ...(parentId ? { parentId } : {}) });
        toast('success', fmt(t('workspace.copiedIn'), { name: copy.relativePath ?? '' }));
      }
    } else if (payload.workspaceId === workspaceId) {
      const from = await registerEntry(workspaceId, payload.entryId);
      const moved = await moveFile(from.fileId, parentId, payload.name, newOperationId());
      applyRecord(moved);
      toast('success', fmt(t('workspace.moved'), { path: moved.relativePath ?? '' }));
    } else {
      const from = await registerEntry(payload.workspaceId, payload.entryId);
      const copy = await copyAcrossWorkspaces(from.fileId, payload.name, { workspaceId, ...(parentId ? { parentId } : {}) });
      toast('success', fmt(t('workspace.copiedIn'), { name: copy.relativePath ?? '' }));
    }
    if (target) setExpanded((prev) => new Set(prev).add(target.entryId));
    reloadTree();
  });

  const dropHandlers = (target: FileEntry | null) => {
    const key = target?.entryId ?? ROOT;
    return {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes(RESOURCE_DRAG_TYPE) || workspace?.readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        setDropOn(key);
      },
      onDragLeave: () => setDropOn((current) => (current === key ? null : current)),
      onDrop: (e: DragEvent) => {
        const payload = parseDragPayload(e.dataTransfer.getData(RESOURCE_DRAG_TYPE));
        setDropOn(null);
        if (!payload || workspace?.readOnly) return;
        e.preventDefault();
        e.stopPropagation();
        void dropInto(target, payload);
      },
    };
  };

  const note = (depth: number, text: string) => (
    <div className="text-2xs text-ink-faint py-1 pr-2 leading-snug" style={{ paddingLeft: 12 + depth * 14 + 18 }}>{text}</div>
  );

  const rows = (parent: FileEntry | null, depth: number): ReactNode => {
    const listing = listings[parent?.entryId ?? ROOT];
    if (listing === undefined || listing === 'loading') return note(depth, t('workspace.loading'));
    if (!Array.isArray(listing)) return note(depth, fmt(t('workspace.listFailed'), { why: listing.error }));
    if (listing.length === 0) return note(depth, t('workspace.emptyFolder'));
    return listing.map((entry) => {
      const pad = { paddingLeft: 12 + depth * 14 };
      if (entry.kind === 'folder') {
        const open = expanded.has(entry.entryId);
        return (
          <Fragment key={entry.entryId}>
            <button
              onClick={(e) => { e.stopPropagation(); toggle(entry); }}
              {...dropHandlers(entry)}
              style={pad}
              data-tree-folder={entry.name}
              className={`w-full pr-2 py-1 flex items-center gap-1.5 text-xs text-ink text-left transition-colors ${
                dropOn === entry.entryId ? 'bg-accent/15' : folder?.entryId === entry.entryId ? 'bg-wash' : 'hover:bg-wash'
              }`}
            >
              {open ? <ChevronDown size={13} strokeWidth={1.75} className="text-ink-faint shrink-0" /> : <ChevronRight size={13} strokeWidth={1.75} className="text-ink-faint shrink-0" />}
              <Folder size={14} strokeWidth={1.75} className="text-ink-muted shrink-0" />
              <span className="truncate">{entry.name}</span>
            </button>
            {open && rows(entry, depth + 1)}
          </Fragment>
        );
      }
      const isFile = entry.kind === 'file';
      return (
        <div
          key={entry.entryId}
          draggable={isFile}
          onDragStart={(e) => {
            if (!workspaceId) return;
            e.dataTransfer.setData(RESOURCE_DRAG_TYPE, JSON.stringify({ kind: 'file-ref', workspaceId, entryId: entry.entryId, name: entry.name } satisfies DragPayload));
            e.dataTransfer.effectAllowed = 'copyMove';
          }}
          onClick={(e) => { e.stopPropagation(); setFolder(parent); }}
          onDoubleClick={() => { if (isFile && !relinkNodeId) void addToCanvas(entry); }}
          style={{ paddingLeft: pad.paddingLeft + 18 }}
          data-tree-file={entry.name}
          className={`group pr-1.5 py-1 flex items-center gap-1.5 text-xs hover:bg-wash transition-colors ${isFile ? 'text-ink cursor-grab' : 'text-ink-faint'}`}
        >
          <FileIcon size={13} strokeWidth={1.75} className="text-ink-faint shrink-0" />
          <span className="truncate flex-1 min-w-0" title={entry.name}>{entry.name}</span>
          {isFile && relinkNodeId && (
            <button onClick={() => void relink(entry)} data-tree-relink className="shrink-0 text-2xs text-accent bg-accent/10 hover:bg-accent/20 rounded-full px-2 py-0.5 transition-colors">
              {t('resource.relinkHere')}
            </button>
          )}
          {isFile && !relinkNodeId && (
            <span className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              <button onClick={() => void addToCanvas(entry)} title={t('workspace.addToCanvas')} data-tree-add className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-accent"><Plus size={13} strokeWidth={1.75} /></button>
              <button onClick={() => void reveal(entry)} title={t('workspace.reveal')} data-tree-reveal className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-accent"><FolderOpen size={12} strokeWidth={1.75} /></button>
              {!workspace?.readOnly && (
                <button onClick={() => void trash(entry)} title={t('workspace.trash')} data-tree-trash className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-red-500"><Trash2 size={12} strokeWidth={1.75} /></button>
              )}
            </span>
          )}
        </div>
      );
    });
  };

  const tool = 'w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:bg-wash disabled:opacity-40 disabled:hover:bg-transparent transition-colors';
  const item = 'w-full px-3 py-1.5 text-xs text-ink hover:bg-wash transition-colors text-left';
  const openers = (
    <>
      <button className={item} data-open-folder onClick={() => { setMenu(null); void attempt(async () => { await pickWorkspaceFolder(); }); }}>{t('workspace.openFolder')}</button>
      <button className={item} data-open-default onClick={() => { setMenu(null); void attempt(async () => { await openCanvasFolder(); }); }}>{t('workspace.useDefault')}</button>
      <button className={item} data-open-space onClick={() => { setMenu(null); setSpaceNotice(true); }}>{t('workspace.openSpace')}</button>
    </>
  );

  return (
    <div className="absolute left-4 top-[64px] bottom-[176px] w-[272px] z-20 flex flex-col bg-card/95 backdrop-blur border border-line rounded-xl shadow-sm overflow-hidden" data-workspace-explorer>
      <div className="relative border-b border-line/70 shrink-0">
        <div className="flex items-center gap-1.5 pl-3 pr-1.5 pt-1.5">
          <span className="text-xs font-medium text-ink truncate flex-1 min-w-0" title={workspace?.displayName} data-workspace-name>{workspace?.displayName ?? t('workspace.title')}</span>
          {workspace?.readOnly && <span className="text-2xs text-ink-faint bg-wash px-1.5 py-0.5 rounded-full shrink-0">{t('workspace.readOnly')}</span>}
          <button className={tool} onClick={() => useWorkspacePanel.setState({ open: false })} title={t('workspace.close')} data-tree-close><X size={15} strokeWidth={1.75} /></button>
        </div>
        {workspace ? (
          <div className="flex items-center gap-0.5 px-1.5 pb-1">
            <button className={tool} disabled={workspace.readOnly}
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCreateAt({ left: r.left, top: r.bottom + 4 }); setMenu(menu === 'create' ? null : 'create'); }}
              title={fmt(t('workspace.newFileIn'), { dir: folder?.name ?? workspace.displayName })} data-tree-new-file>
              <FilePlus size={15} strokeWidth={1.75} />
            </button>
            <button className={tool} disabled={workspace.readOnly} onClick={() => setImporting('other')} title={t('workspace.importCopy')} data-tree-import><ClipboardPaste size={15} strokeWidth={1.75} /></button>
            <button className={tool} onClick={reloadTree} title={t('workspace.refresh')} data-tree-refresh><RefreshCw size={14} strokeWidth={1.75} /></button>
            <button className={tool} onClick={() => setMenu(menu === 'open' ? null : 'open')} title={t('workspace.open')} data-tree-open><FolderOpen size={15} strokeWidth={1.75} /></button>
            <span className="text-2xs text-ink-faint truncate min-w-0 pl-1.5" data-tree-target>{folder ? folder.name : t('workspace.root')}</span>
          </div>
        ) : <div className="pb-1" />}
        {menu === 'open' && <div className="absolute left-2 right-2 top-full mt-1 z-30 bg-card border border-line rounded-xl shadow-lg py-1" data-open-menu>{openers}</div>}
      </div>

      {relinkNodeId && (
        <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-2xs text-amber-800 leading-snug flex items-start gap-2 shrink-0" data-relink-banner>
          <span className="flex-1 min-w-0">{fmt(t('resource.relinkBanner'), { name: relinkName ?? '' })}</span>
          <button onClick={() => useWorkspacePanel.setState({ relinkNodeId: null })} className="shrink-0 underline hover:no-underline">{t('resource.relinkCancel')}</button>
        </div>
      )}

      {spaceNotice && (
        <div className="px-3 py-2 bg-wash border-b border-line/70 text-2xs text-ink-muted leading-snug shrink-0" data-space-notice>
          <p>{t('workspace.spaceBlocked')}</p>
          <div className="flex gap-3 mt-1.5">
            {workspace && !workspace.readOnly && <button onClick={() => { setSpaceNotice(false); setImporting('chatgpt-space'); }} className="text-accent hover:underline" data-space-import>{t('workspace.importCopy')}</button>}
            <button onClick={() => setSpaceNotice(false)} className="hover:underline">{t('common.close')}</button>
          </div>
        </div>
      )}

      {!workspaceAvailable() ? (
        <p className="px-3 py-4 text-xs text-ink-muted">{t('workspace.desktopOnly')}</p>
      ) : !workspace ? (
        <div className="py-2" data-workspace-empty>
          <p className="px-3 py-2 text-xs text-ink-muted">{t('workspace.empty')}</p>
          {openers}
        </div>
      ) : (
        <div className={`flex-1 min-h-0 overflow-y-auto py-1 ${dropOn === ROOT ? 'bg-accent/5' : ''}`} onClick={() => setFolder(null)} {...dropHandlers(null)} data-tree>
          {rows(null, 0)}
        </div>
      )}

      {menu === 'create' && workspace && (
        <CreateFileMenu
          title={fmt(t('workspace.newFileIn'), { dir: folder?.name ?? workspace.displayName })}
          style={createAt}
          onPick={(extension) => void create(extension)}
          onClose={() => setMenu(null)}
        />
      )}
      {importing && workspace && (
        <ImportCopyDialog
          workspaceId={workspace.workspaceId}
          parentId={folder?.entryId}
          source={importing}
          onClose={() => setImporting(null)}
          onFailed={(reason) => toast('error', fmt(t('workspace.failed'), { why: reason }))}
          onDone={(record) => {
            setImporting(null);
            if (folder) setExpanded((prev) => new Set(prev).add(folder.entryId));
            reloadTree();
            toast('success', fmt(t('workspace.imported'), { name: record.relativePath ?? '' }));
          }}
        />
      )}
    </div>
  );
}
