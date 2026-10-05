// Real workspace files on the canvas. A resource node is a file content
// node that stands for a file in a workspace: it carries the file's
// identity (`resourceRef.fileId`) and a hint of where it is for display.
// Several nodes may reference one file; deleting a node deletes no file;
// moving the file moves no node. The node also holds a copy of the file's
// content as its attachment, which is what flows into context along its
// edge, and that copy is refreshed whenever the workspace reports a change.
//
// The copy is one attachment for the life of the node. When the file's
// content changes, the attachment's content is replaced and its id stays:
// what other nodes decided about it (left out of a question, taken back
// in) is recorded against that id and must go on meaning the same file.
//
// The copy is the file's state, not something the person did on the
// canvas. It is no step in the undo history, and undoing a step never
// takes the copy back to what the file used to hold.
//
// Nothing here acts on a path. Every operation names the file by its id and
// goes through the workspace door.

import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import type { Attachment, ThoughtNode } from '../../types';
import { buildContentNode } from '../content';
import { processFile } from '../attachments';
import { moveVaulted } from '../attachment-vault';
import { canvasVisit } from './canvas-visit';
import { importText, moveFile, newOperationId, readSource, readText, reconcileFile, registerEntry, relinkFile, WorkspaceError } from './client';
import { validateDTO, type ResourceRecord, type ResourceRef, type WorkspaceEvent } from './contracts';

type Position = { x: number; y: number };
type ResourceHint = NonNullable<ThoughtNode['data']['resourceHint']>;

/** The drag type a file, a selection or a graph node travels under inside the app. */
export const RESOURCE_DRAG_TYPE = 'application/thoughtdag-resource';

/** What is being dragged. Ids only: a payload never carries a path. */
export type DragPayload =
  | { kind: 'file-ref'; workspaceId: string; entryId: string; name: string }
  | { kind: 'selection-ref'; workspaceId: string; name: string; ref: ResourceRef }
  | { kind: 'graph-node'; nodeId: string };

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const hasOnly = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** A drag payload, or null for anything that is not exactly one: unknown
 *  kinds, extra fields (a path, say) and malformed references are all refused. */
export function parseDragPayload(raw: string): DragPayload | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const p = o as Record<string, unknown>;
  if (p.kind === 'file-ref' && hasOnly(p, ['kind', 'workspaceId', 'entryId', 'name']) && isId(p.workspaceId) && isId(p.entryId) && typeof p.name === 'string') {
    return { kind: 'file-ref', workspaceId: p.workspaceId, entryId: p.entryId, name: p.name };
  }
  if (p.kind === 'selection-ref' && hasOnly(p, ['kind', 'workspaceId', 'name', 'ref']) && isId(p.workspaceId) && typeof p.name === 'string' && validateDTO('ResourceRef', p.ref).ok) {
    return { kind: 'selection-ref', workspaceId: p.workspaceId, name: p.name, ref: p.ref as ResourceRef };
  }
  if (p.kind === 'graph-node' && hasOnly(p, ['kind', 'nodeId']) && isId(p.nodeId)) return { kind: 'graph-node', nodeId: p.nodeId };
  return null;
}

const nameOf = (record: ResourceRecord): string => (record.relativePath ?? '').split('/').pop() || record.fileId;
const hintOf = (record: ResourceRecord, revision: string | null = record.revision): ResourceHint => ({
  workspaceId: record.workspaceId, name: nameOf(record), relativePath: record.relativePath, status: record.status, revision,
  ...(record.origin === 'import' ? { imported: true } : {}),
});

/** Every node on the canvas that references this file. */
export function nodesOfFile(fileId: string): ThoughtNode[] {
  return useStore.getState().nodes.filter((n) => n.data.resourceRef?.fileId === fileId);
}

function patchNodes(fileId: string, patch: (data: ThoughtNode['data']) => Partial<ThoughtNode['data']>) {
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.data.resourceRef?.fileId === fileId ? { ...n, data: { ...n.data, ...patch(n.data) } } : n)),
  }));
}

// One count per node of the refreshes started for it. A refresh that is no
// longer the newest when its read comes back writes nothing: an older read
// must not land on top of a newer one.
const refreshSerial = new Map<string, number>();

// What each file was last seen to hold and where, by file id: the state of
// the files the open canvas refers to, kept apart from the canvas's own
// history. It is what a node is brought back to after an undo or a redo
// put an older picture of the canvas in the store. It belongs to one visit
// of one canvas and is dropped when that changes.
interface LiveFile { hint?: ResourceHint; revision?: string | null; copy?: Attachment | null; uncopied?: ResourceHint['uncopied'] }
const live = new Map<string, LiveFile>();
let liveVisit = -1;
function liveOf(fileId: string): LiveFile {
  if (liveVisit !== canvasVisit()) { live.clear(); liveVisit = canvasVisit(); }
  let known = live.get(fileId);
  if (!known) { known = {}; live.set(fileId, known); }
  return known;
}

/** A hint that no longer says the node is a reference without a copy. */
function withCopy(hint: ResourceHint): ResourceHint {
  const next = { ...hint };
  delete next.uncopied;
  return next;
}

/**
 * The attachment a node holds for a new copy of its file: the new content
 * under the id the node's copy already had, with what the person chose for
 * how it is shown. A node that had no copy takes the new one as it is.
 */
function sameAttachment(held: Attachment | undefined, fresh: Attachment): Attachment {
  if (!held) return fresh;
  return { ...fresh, id: held.id, ...(held.addedAt ? { addedAt: held.addedAt } : {}), ...(held.renderMode ? { renderMode: held.renderMode } : {}) };
}

/**
 * Take a fresh copy of the file's content into the node, replacing the
 * content of the copy it held. The node keeps its place, its edges, its
 * identity, and the identity of its copy. A file that cannot be read leaves
 * the node as a reference without a copy. The copy and the revision it was
 * taken at change together, in one step, once the new copy is whole. A file
 * the shell will not send (too large) or that is no kind the pipeline reads
 * leaves the node a reference with no copy, and the node says which.
 *
 * The read belongs to the canvas, the visit, the node and the file it was
 * started for. If any of those is different when it comes back (another
 * canvas was opened, this one was opened anew, the node now references
 * another file, a newer read was started) it writes nothing.
 */
export async function refreshResourceNode(nodeId: string, knownRevision: string | null = null): Promise<void> {
  const node = useStore.getState().nodes.find((n) => n.id === nodeId);
  const ref = node?.data.resourceRef;
  const hint = node?.data.resourceHint;
  if (!node || !ref || !hint) return;
  const fileId = ref.fileId;
  const canvasId = useProjects.getState().activeId;
  const visit = canvasVisit();
  const serial = (refreshSerial.get(nodeId) ?? 0) + 1;
  refreshSerial.set(nodeId, serial);
  const nodeNow = () => useStore.getState().nodes.find((n) => n.id === nodeId);
  const stillWanted = () => canvasVisit() === visit && useProjects.getState().activeId === canvasId
    && refreshSerial.get(nodeId) === serial && nodeNow()?.data.resourceRef?.fileId === fileId;

  /** Leave the node as a reference with no copy of the content, and say why. */
  const referenceOnly = (uncopied: NonNullable<ResourceHint['uncopied']>, revision: string | null) => {
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => (n.id === nodeId && n.data.resourceHint ? { ...n, data: { ...n.data, attachments: [], resourceHint: { ...n.data.resourceHint, revision, uncopied } } } : n)),
    }));
    Object.assign(liveOf(fileId), { revision, copy: null, uncopied });
  };

  let read;
  try { read = await readSource(fileId); } catch (e) {
    // too large to be sent to the page: none of it was read, so its revision is whatever was already known
    if (e instanceof WorkspaceError && e.code === 'too-large' && stillWanted()) { referenceOnly('too-large', knownRevision ?? nodeNow()?.data.resourceHint?.revision ?? null); return; }
    throw e;
  }
  if (!stillWanted()) return;
  const revision = read.contentHash;
  const bytes = typeof read.payload === 'string' ? new TextEncoder().encode(read.payload) : read.payload as Uint8Array;
  const name = nodeNow()?.data.resourceHint?.name ?? hint.name;
  const type = copyableAs(name, bytes);
  let fresh: Attachment | null = null;
  if (type !== null) {
    // the pipeline hands the attachment over and may fill it in afterwards (extracted text); it is taken once it is whole
    await processFile(new File([bytes as BlobPart], name, { type }), {
      add: (att) => { fresh = att; },
      update: (_attId, change) => { if (fresh) fresh = { ...fresh, ...change }; },
    });
  }
  if (!stillWanted()) return;
  const made = fresh as Attachment | null;
  if (!made) { referenceOnly(type === null && bytes.length > MAX_COPY_BYTES ? 'too-large' : 'unreadable', revision); return; }
  const held = nodeNow()?.data.attachments?.[0];
  const copy = sameAttachment(held, made);
  // a payload kept outside the node is kept under the attachment's id: it follows the id
  if (made.contentInVault && copy.id !== made.id) await moveVaulted(made.id, copy.id);
  if (!stillWanted()) return;
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => {
      if (n.id !== nodeId || !n.data.resourceHint) return n;
      return { ...n, data: { ...n.data, attachments: [copy], resourceHint: { ...withCopy(n.data.resourceHint), revision } } };
    }),
  }));
  Object.assign(liveOf(fileId), { revision, copy, uncopied: undefined });
}

/**
 * Bring every file node in the store in line with what its file was last
 * seen to hold. Called after an undo or a redo: the picture of the canvas
 * that came back is of the canvas, and whatever it says of the files is as
 * old as the picture. Where the file's state is known here the node is put
 * right at once; where it is not, the workspace is asked.
 */
function bringCopiesUpToDate(): void {
  const stale: string[] = [];
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => {
      const fileId = n.data.resourceRef?.fileId;
      const hint = n.data.resourceHint;
      if (!fileId || !hint) return n;
      const known = live.get(fileId);
      if (liveVisit !== canvasVisit() || !known) { stale.push(n.id); return n; }
      let data = n.data;
      if (known.hint) data = { ...data, resourceHint: { ...known.hint, revision: hint.revision } };
      if (known.revision !== undefined && known.revision !== hint.revision) {
        // a payload kept outside the node belongs to the node that read it: this one reads its own
        if (known.copy?.contentInVault) stale.push(n.id);
        else {
          data = { ...data, attachments: known.copy ? [sameAttachment(n.data.attachments?.[0], known.copy)] : [], resourceHint: { ...withCopy(data.resourceHint!), revision: known.revision, ...(known.uncopied ? { uncopied: known.uncopied } : {}) } };
        }
      }
      return data === n.data ? n : { ...n, data };
    }),
  }));
  for (const nodeId of stale) void refreshResourceNode(nodeId).catch(() => {});
  // and the workspace is asked about every file: a node that came back may reference one nobody was watching
  void syncResourceNodes().catch(() => {});
}

/**
 * Keep file nodes showing what their files hold now when the person undoes
 * or redoes a step on the canvas. Returns the function that stops it.
 */
export function keepCopiesOutOfHistory(): () => void {
  return useStore.subscribe((now, before) => {
    // an undo or a redo: the canvas is replaced by a picture of itself and the list of pictures stays as it is
    if (now.historyIndex !== before.historyIndex && now.history === before.history && now.nodes !== before.nodes) bringCopiesUpToDate();
  });
}

/** Above this a node keeps the reference and takes no copy of the content. */
const MAX_COPY_BYTES = 8 * 1024 * 1024;

/**
 * The media type to hand the attachment pipeline for a copy of this file, or
 * null when the node should hold no copy: a file too large, or one that is
 * neither a kind the pipeline reads (PDF, image, HTML, Word) nor valid text.
 */
function copyableAs(name: string, bytes: Uint8Array): string | null {
  if (bytes.length > MAX_COPY_BYTES) return null;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (ext === 'pdf') return 'application/pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (ext === 'html' || ext === 'htm') return 'text/html';
  if (ext === 'docx') return '';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  return 'text/plain';
}

/**
 * Put a reference to a workspace file on the canvas. `graphId` must be the
 * canvas that is open. The node is not wired to anything. Resolves with the
 * new node's id once the node holds its copy of the content (or once it is
 * clear it cannot: the reference stands either way).
 */
export async function attachResource(graphId: string, ref: ResourceRef, position: Position, record: ResourceRecord): Promise<string> {
  if (useProjects.getState().activeId !== graphId) throw new WorkspaceError('wrong-graph', 'that canvas is not the one that is open');
  if (!validateDTO('ResourceRef', ref).ok || ref.fileId !== record.fileId) throw new WorkspaceError('invalid-request', 'that is not a reference to this file');
  const node = buildContentNode('file', position);
  node.data.resourceRef = ref;
  node.data.resourceHint = hintOf(record, null);
  const st = useStore.getState();
  st.setNodes([...st.nodes, node]);
  st.pushHistory();
  await refreshResourceNode(node.id).catch(() => { /* a reference without a copy */ });
  return node.id;
}

/** attachResource for a file picked in the tree: it gets its identity first. */
export async function attachEntry(graphId: string, workspaceId: string, entryId: string, position: Position): Promise<string> {
  const record = await registerEntry(workspaceId, entryId);
  return attachResource(graphId, { fileId: record.fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }, position, record);
}

/**
 * What the workspace says about a file now, applied to every node that
 * references it: where it is, whether it is still there, and a fresh copy
 * of its content when that changed.
 */
export function applyRecord(record: ResourceRecord): void {
  liveOf(record.fileId).hint = hintOf(record, null);
  const affected = nodesOfFile(record.fileId);
  if (affected.length === 0) return;
  patchNodes(record.fileId, (data) => ({ resourceHint: { ...hintOf(record, data.resourceHint?.revision ?? null), ...(data.resourceHint?.uncopied ? { uncopied: data.resourceHint.uncopied } : {}) } }));
  const readable = record.status === 'ready' || record.status === 'readonly';
  for (const node of affected) {
    if (readable && node.data.resourceHint?.revision !== record.revision) void refreshResourceNode(node.id, record.revision).catch(() => {});
  }
}

/** A change the workspace reported, applied to the nodes that reference the file. */
export function applyWorkspaceEvent(event: WorkspaceEvent): void {
  applyRecord(event.record);
}

/**
 * Bring every node that references a file up to date with its workspace:
 * what a canvas does when it is opened, since files move and change while
 * it is closed. A file no open workspace knows is shown as missing; its
 * node keeps its last copy.
 */
export async function syncResourceNodes(): Promise<void> {
  const fileIds = [...new Set(useStore.getState().nodes.map((n) => n.data.resourceRef?.fileId).filter((id): id is string => !!id))];
  await Promise.all(fileIds.map(async (fileId) => {
    try {
      applyRecord(await reconcileFile(fileId));
    } catch (e) {
      if (e instanceof WorkspaceError && e.code === 'unavailable') return;
      const known = liveOf(fileId);
      if (known.hint) known.hint = { ...known.hint, status: 'missing' };
      patchNodes(fileId, (data) => (data.resourceHint ? { resourceHint: { ...data.resourceHint, status: 'missing' } } : {}));
    }
  }));
}

/**
 * Move the file a node references to another folder of its workspace (or
 * rename it there). The nodes are updated only after the workspace says the
 * move happened; if it did not, they still show where the file is.
 */
export async function moveReferencedFile(nodeId: string, targetParentId: string | undefined, newName?: string): Promise<ResourceRecord> {
  const node = useStore.getState().nodes.find((n) => n.id === nodeId);
  const ref = node?.data.resourceRef;
  const hint = node?.data.resourceHint;
  if (!ref || !hint) throw new WorkspaceError('invalid-request', 'that node does not reference a file');
  const moved = await moveFile(ref.fileId, targetParentId, newName ?? hint.name, newOperationId());
  applyRecord(moved);
  return moved;
}

/** The person says the lost file a node references is the entry they picked. */
export async function relinkNode(nodeId: string, entryId: string): Promise<ResourceRecord> {
  const ref = useStore.getState().nodes.find((n) => n.id === nodeId)?.data.resourceRef;
  if (!ref) throw new WorkspaceError('invalid-request', 'that node does not reference a file');
  const record = await relinkFile(ref.fileId, entryId);
  applyRecord(record);
  return record;
}

/**
 * Bring a text file from another workspace into this one as a copy. A file
 * is never moved between workspaces, and the copy is marked as one: it is a
 * new file here with a new identity, and nothing ties it to the original.
 */
export async function copyAcrossWorkspaces(sourceFileId: string, sourceName: string, target: { workspaceId: string; parentId?: string }): Promise<ResourceRecord> {
  const { text } = await readText(sourceFileId);
  const dot = sourceName.lastIndexOf('.');
  const stem = dot > 0 ? sourceName.slice(0, dot) : sourceName;
  const extension = dot > 0 ? sourceName.slice(dot + 1) : 'txt';
  return importText(
    { workspaceId: target.workspaceId, ...(target.parentId ? { parentId: target.parentId } : {}), extension, origin: 'workspace', idempotencyKey: newOperationId() },
    { text, name: stem, provenance: { source: 'other', note: sourceName } },
  );
}
