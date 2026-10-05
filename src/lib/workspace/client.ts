// The renderer's side of the workspace door (window.desktopWorkspace).
// Everything here speaks in ids: a workspace id, an entry id, a file id.
// What comes back from the shell is checked against the contract before any
// other code sees it, so a shell and a page of different versions fail
// loudly here instead of quietly somewhere else.

import { validateDTO, type ContentHash, type CreateFileRequest, type FileEntry, type FileVersion, type ImportProvenance, type RecoveryItem, type ResourceRecord, type SaveResult, type SourceCapabilities, type SourceRead, type TextRevision, type TrashReceipt, type WorkspaceDTOs, type WorkspaceRecord } from './contracts';

/** A workspace call the shell refused or could not complete. `code` is
 *  stable (traversal, escapes-root, read-only, no-grant, …); the message is
 *  for a person and never carries a path. */
export class WorkspaceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}

/** Real project folders need the desktop shell; the web build has none. */
export const workspaceAvailable = (): boolean => typeof window !== 'undefined' && !!window.desktopWorkspace;

function bridge(): DesktopWorkspaceBridge {
  const b = typeof window !== 'undefined' ? window.desktopWorkspace : undefined;
  if (!b) throw new WorkspaceError('unavailable', 'project folders need the desktop app');
  return b;
}

/** The shell answers a refusal as `<code>: <words>`, wrapped by the IPC layer. */
function asWorkspaceError(e: unknown): WorkspaceError {
  if (e instanceof WorkspaceError) return e;
  const text = e instanceof Error ? e.message : String(e);
  const m = /(?:^|: )([a-z][a-z-]*): ([^:].*)$/.exec(text);
  return m ? new WorkspaceError(m[1], m[2]) : new WorkspaceError('failed', 'the workspace call failed');
}

function checked<K extends keyof WorkspaceDTOs>(kind: K, value: unknown): WorkspaceDTOs[K] {
  const result = validateDTO(kind, value);
  if (!result.ok) throw new WorkspaceError('contract', `the shell answered with a ${kind} this version does not understand`);
  return result.value;
}

async function call<T>(run: (b: DesktopWorkspaceBridge) => Promise<T>): Promise<T> {
  const b = bridge();
  try { return await run(b); } catch (e) { throw asWorkspaceError(e); }
}

/** Ask the person for a folder and open it. Null when they cancel. */
export async function chooseRoot(): Promise<WorkspaceRecord | null> {
  const record = await call((b) => b.chooseRoot());
  return record === null ? null : checked('WorkspaceRecord', record);
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
  const records = await call((b) => b.listWorkspaces());
  if (!Array.isArray(records)) throw new WorkspaceError('contract', 'the shell answered with something that is not a list');
  return records.map((r) => checked('WorkspaceRecord', r));
}

/** Close a workspace. Nothing in the folder is touched. */
export function closeWorkspace(workspaceId: string): Promise<boolean> {
  return call((b) => b.close(workspaceId));
}

/** The entries of one folder (the root when `parentId` is absent): names and kinds, no content. */
export async function listChildren(workspaceId: string, parentId?: string): Promise<FileEntry[]> {
  const entries = await call((b) => b.listChildren(workspaceId, parentId));
  if (!Array.isArray(entries)) throw new WorkspaceError('contract', 'the shell answered with something that is not a list');
  return entries.map((e) => checked('FileEntry', e));
}

/** Give a file its identity, or get the one it has. */
export async function registerEntry(workspaceId: string, entryId: string): Promise<ResourceRecord> {
  return checked('ResourceRecord', await call((b) => b.registerEntry(workspaceId, entryId)));
}

/** An id for one operation. Asking again with the same id returns the same
 *  answer instead of doing the work twice, so a retry after a lost reply is safe. */
export const newOperationId = (): string => `op_${crypto.randomUUID()}`;

function request(value: CreateFileRequest): CreateFileRequest {
  const result = validateDTO('CreateFileRequest', value);
  if (!result.ok) throw new WorkspaceError('invalid-request', 'that is not a request to create a file');
  return value;
}

/** Create a file. The shell picks the name; a graph file goes to Graph Files. */
export async function createFile(req: CreateFileRequest): Promise<ResourceRecord> {
  const checkedRequest = request(req);
  return checked('ResourceRecord', await call((b) => b.createFile(checkedRequest)));
}

/**
 * Bring text in as a new local file marked as a copy (what was copied out of
 * a space page, say). It is an ordinary local file from then on: nothing
 * keeps it in step with where it came from.
 */
export async function importText(req: CreateFileRequest, options: { text: string; name?: string | null; provenance: Pick<ImportProvenance, 'source' | 'note'> }): Promise<ResourceRecord> {
  const checkedRequest = request(req);
  return checked('ResourceRecord', await call((b) => b.importText(checkedRequest, options)));
}

/** Create a folder; resolves with its entry id. */
export function createFolder(workspaceId: string, parentId: string | undefined, name: string): Promise<string> {
  return call((b) => b.createFolder(workspaceId, parentId, name));
}

/** A file's text and the revision a later save must name. */
export async function readText(fileId: string): Promise<TextRevision> {
  return checked('TextRevision', await call((b) => b.readText(fileId)));
}

/**
 * Replace a file's text if it still holds the revision that was read.
 * Resolves with the outcome: `saved` only when the new text is in place; a
 * conflict, a read-only file and a failure are results, not exceptions.
 */
export async function saveText(fileId: string, baseRevision: ContentHash, text: string, opId: string): Promise<SaveResult> {
  return checked('SaveResult', await call((b) => b.saveText(fileId, baseRevision, text, opId)));
}

/** Move or rename a file inside its workspace. It keeps its fileId. */
export async function moveFile(fileId: string, targetParentId: string | undefined, newName: string, opId: string): Promise<ResourceRecord> {
  return checked('ResourceRecord', await call((b) => b.moveFile(fileId, targetParentId, newName, opId)));
}

/** Copy a file inside its workspace. The copy is a new file with a new fileId. */
export async function copyFile(fileId: string, targetParentId: string | undefined, newName: string, opId: string): Promise<ResourceRecord> {
  return checked('ResourceRecord', await call((b) => b.copyFile(fileId, targetParentId, newName, opId)));
}

/** Take a file out of the workspace without destroying it. */
export async function trashFile(fileId: string, opId: string): Promise<TrashReceipt> {
  return checked('TrashReceipt', await call((b) => b.trashFile(fileId, opId)));
}

/** Bring one file's record in line with the disk. */
export async function reconcileFile(fileId: string): Promise<ResourceRecord> {
  return checked('ResourceRecord', await call((b) => b.reconcile(fileId)));
}

/** Reconcile every registered file of a workspace; resolves with the ones that changed. */
export async function rescanWorkspace(workspaceId: string): Promise<ResourceRecord[]> {
  const records = await call((b) => b.rescan(workspaceId));
  if (!Array.isArray(records)) throw new WorkspaceError('contract', 'the shell answered with something that is not a list');
  return records.map((r) => checked('ResourceRecord', r));
}

/** The person says a lost file is the entry they picked. */
export async function relinkFile(fileId: string, entryId: string): Promise<ResourceRecord> {
  return checked('ResourceRecord', await call((b) => b.relink(fileId, entryId)));
}

/** A file's bytes and their content hash, whatever the file is. */
/**
 * A file's content as its source gives it: text, or bytes for what is not
 * text, with the hash of what was read. The shell refuses a file too large
 * to send (`too-large`) without reading it.
 */
export async function readSource(fileId: string): Promise<SourceRead> {
  const result = await call((b) => b.readSource(fileId));
  // the bytes cross a context boundary, so they are recognised by what they are, not by whose constructor made them
  const text = result?.representation === 'text' && typeof result.payload === 'string';
  const bytes = result?.representation === 'bytes' && ArrayBuffer.isView(result.payload);
  if (!result || !(text || bytes) || !validateDTO('ContentHash', result.contentHash).ok) throw new WorkspaceError('contract', 'the shell answered with something that is not file content');
  if (!bytes) return result;
  const view = result.payload as unknown as ArrayBufferView;
  return { ...result, payload: new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength) };
}

/** Move or rename a folder. The files in it keep their identities. Resolves with the folder's new entry id. */
export function moveFolder(workspaceId: string, entryId: string, targetParentId: string | undefined, newName: string, opId: string): Promise<string> {
  return call((b) => b.moveFolder(workspaceId, entryId, targetParentId, newName, opId));
}

/** Copy a folder and everything in it under a new name. Resolves with the copy's entry id. */
export function copyFolder(workspaceId: string, entryId: string, targetParentId: string | undefined, newName: string, opId: string): Promise<string> {
  return call((b) => b.copyFolder(workspaceId, entryId, targetParentId, newName, opId));
}

/** Trash a folder. Resolves with what is now in the workspace's recovery area, or null when the system trash took it. */
export async function trashFolder(workspaceId: string, entryId: string, opId: string): Promise<RecoveryItem | null> {
  const item = await call((b) => b.trashFolder(workspaceId, entryId, opId));
  return item === null ? null : checked('RecoveryItem', item);
}

/** What was trashed into a workspace's recovery area and can be put back. */
export async function listRecovery(workspaceId: string): Promise<RecoveryItem[]> {
  const items = await call((b) => b.listRecovery(workspaceId));
  if (!Array.isArray(items)) throw new WorkspaceError('contract', 'the shell answered with something that is not a list');
  return items.map((item) => checked('RecoveryItem', item));
}

/** Put something back from the recovery area where it was. Resolves with its entry id. */
export function restoreFromRecovery(workspaceId: string, receiptId: string, opId: string): Promise<string> {
  return call((b) => b.restore(workspaceId, receiptId, opId));
}

/** What a file held before each save that replaced it, newest first. */
export async function listVersions(fileId: string): Promise<FileVersion[]> {
  const versions = await call((b) => b.listVersions(fileId));
  if (!Array.isArray(versions)) throw new WorkspaceError('contract', 'the shell answered with something that is not a list');
  return versions.map((version) => checked('FileVersion', version));
}

/** Put an earlier version of a file back, if the file still holds `baseRevision`. */
export async function restoreVersion(fileId: string, revision: ContentHash, baseRevision: ContentHash, opId: string): Promise<SaveResult> {
  return checked('SaveResult', await call((b) => b.restoreVersion(fileId, revision, baseRevision, opId)));
}

/** Whether a subscribed workspace's changes are noticed on their own. False means only an explicit rescan finds them. */
export async function workspaceWatched(workspaceId: string): Promise<boolean> {
  return (await call((b) => b.watching(workspaceId))) === true;
}

/** What the source of a workspace supports. What to offer the person is decided from this, never from the kind of source. */
export async function workspaceCapabilities(workspaceId: string): Promise<SourceCapabilities> {
  return checked('SourceCapabilities', await call((b) => b.capabilities(workspaceId)));
}

/** The canvas's own managed folder, opened as a workspace. No picker: the shell decides where it is. */
export async function openDefaultWorkspace(canvasId: string): Promise<WorkspaceRecord> {
  return checked('WorkspaceRecord', await call((b) => b.openDefault(canvasId)));
}

/** Show a file in the system file manager. It is shown, never opened or run. */
export function revealFile(fileId: string): Promise<boolean> {
  return call((b) => b.reveal(fileId));
}
