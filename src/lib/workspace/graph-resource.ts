// Real workspace files on the canvas. A resource node is a file content
// node that stands for a file in a workspace: it carries the file's
// identity (`resourceRef.fileId`) and a hint of where it is for display.
// Several nodes may reference one file; deleting a node deletes no file;
// moving the file moves no node. The node also holds a copy of the file's
// content as its attachment, which is what flows into context along its
// edge, and that copy is refreshed whenever the workspace reports a change.
//
// Nothing here acts on a path. Every operation names the file by its id and
// goes through the workspace door.

import { useStore } from '../../store';
import { useProjects } from '../../store/projects';
import type { ThoughtNode } from '../../types';
import { buildContentNode } from '../content';
import { processFile } from '../attachments';
import { importText, moveFile, newOperationId, readBytes, readText, reconcileFile, registerEntry, relinkFile, WorkspaceError } from './client';
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

/**
 * Take a fresh copy of the file's content into the node, replacing the copy
 * it held. The node keeps its place, its edges and its identity. A file that
 * cannot be read leaves the node as a reference without a copy. This is the
 * workspace catching up with the file, not something the person did, so it
 * is not a step in the undo history.
 */
export async function refreshResourceNode(nodeId: string): Promise<void> {
  const node = useStore.getState().nodes.find((n) => n.id === nodeId);
  const ref = node?.data.resourceRef;
  const hint = node?.data.resourceHint;
  if (!node || !ref || !hint) return;
  const serial = (refreshSerial.get(nodeId) ?? 0) + 1;
  refreshSerial.set(nodeId, serial);
  const { bytes, revision } = await readBytes(ref.fileId);
  // the node may have gone, or a newer refresh may have started, while the file was read
  const stillWanted = () => refreshSerial.get(nodeId) === serial && !!useStore.getState().nodes.find((n) => n.id === nodeId)?.data.resourceRef;
  if (!stillWanted()) return;
  const patch = (data: (d: ThoughtNode['data']) => Partial<ThoughtNode['data']>) => useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data(n.data) } } : n)),
  }));
  const name = useStore.getState().nodes.find((n) => n.id === nodeId)?.data.resourceHint?.name ?? hint.name;
  const type = copyableAs(name, bytes);
  let copied = false;
  if (type !== null) {
    await processFile(new File([bytes as BlobPart], name, { type }), {
      add: (att) => { if (stillWanted()) { copied = true; patch(() => ({ attachments: [att] })); } },
      update: (attId, change) => { if (stillWanted()) useStore.getState().setAttachmentData(nodeId, attId, change); },
    });
  }
  if (!stillWanted()) return;
  patch((d) => ({
    ...(copied ? {} : { attachments: [] }),
    ...(d.resourceHint ? { resourceHint: { ...d.resourceHint, revision } } : {}),
  }));
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
  const affected = nodesOfFile(record.fileId);
  if (affected.length === 0) return;
  patchNodes(record.fileId, (data) => ({ resourceHint: hintOf(record, data.resourceHint?.revision ?? null) }));
  const readable = record.status === 'ready' || record.status === 'readonly';
  for (const node of affected) {
    if (readable && node.data.resourceHint?.revision !== record.revision) void refreshResourceNode(node.id).catch(() => {});
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
  patchNodes(ref.fileId, (data) => ({ resourceHint: hintOf(moved, data.resourceHint?.revision ?? null) }));
  return moved;
}

/** The person says the lost file a node references is the entry they picked. */
export async function relinkNode(nodeId: string, entryId: string): Promise<ResourceRecord> {
  const ref = useStore.getState().nodes.find((n) => n.id === nodeId)?.data.resourceRef;
  if (!ref) throw new WorkspaceError('invalid-request', 'that node does not reference a file');
  const record = await relinkFile(ref.fileId, entryId);
  patchNodes(ref.fileId, (data) => ({ resourceHint: hintOf(record, data.resourceHint?.revision ?? null) }));
  for (const n of nodesOfFile(ref.fileId)) void refreshResourceNode(n.id).catch(() => {});
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
