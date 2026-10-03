// The renderer's side of the workspace door (window.desktopWorkspace).
// Everything here speaks in ids: a workspace id, an entry id, a file id.
// What comes back from the shell is checked against the contract before any
// other code sees it, so a shell and a page of different versions fail
// loudly here instead of quietly somewhere else.

import { validateDTO, type FileEntry, type ResourceRecord, type WorkspaceDTOs, type WorkspaceRecord } from './contracts';

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
