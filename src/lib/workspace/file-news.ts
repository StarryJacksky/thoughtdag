// What the workspace reports about one file, for a view that shows that
// file and is neither a node on the canvas nor a document open for typing:
// a reader. The page hears every change of the workspaces it is listening
// to (see session.ts) and passes each one on here; whoever shows the file
// hears of it by the file's identity.

import type { WorkspaceEvent } from './contracts';

type FileListener = (event: WorkspaceEvent) => void;
const listeners = new Map<string, Set<FileListener>>();

/** Hear what is reported about one file. Returns the function that stops it. */
export function onFileEvent(fileId: string, listener: FileListener): () => void {
  let of = listeners.get(fileId);
  if (!of) { of = new Set(); listeners.set(fileId, of); }
  of.add(listener);
  return () => {
    of.delete(listener);
    if (of.size === 0 && listeners.get(fileId) === of) listeners.delete(fileId);
  };
}

/** A change the workspace reported: everyone showing that file is told. */
export function noteFileEvent(event: WorkspaceEvent): void {
  for (const listener of [...(listeners.get(event.fileId) ?? [])]) {
    try { listener(event); } catch { /* one view's failure stops no other */ }
  }
}
