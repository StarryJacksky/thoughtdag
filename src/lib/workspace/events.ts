// Changes to a workspace's registered files, as the renderer hears them:
// this application's own operations (the event names the operation) and
// other programs' edits, renames and deletions (it names none).
//
// The shell pushes every event on one channel. This module listens once,
// checks each event against the contract, and hands it to whoever
// subscribed to that workspace. The shell is asked to watch a workspace
// when its first listener arrives and to stop when its last one leaves.

import { validateDTO, type WorkspaceEvent } from './contracts';
import { WorkspaceError } from './client';

export type WorkspaceListener = (event: WorkspaceEvent) => void;

const listeners = new Map<string, Set<WorkspaceListener>>();
let listening = false;

function dispatch(raw: unknown) {
  const result = validateDTO('WorkspaceEvent', raw);
  // an event this version cannot read is dropped: acting on half-understood news is worse than missing it
  if (!result.ok) return;
  for (const listener of listeners.get(result.value.workspaceId) ?? []) {
    try { listener(result.value); } catch { /* one listener's failure stops nobody else */ }
  }
}

/**
 * Hear about changes to a workspace's registered files. Resolves with the
 * function that stops listening.
 */
export async function subscribeWorkspace(workspaceId: string, listener: WorkspaceListener): Promise<() => void> {
  const bridge = typeof window !== 'undefined' ? window.desktopWorkspace : undefined;
  if (!bridge) throw new WorkspaceError('unavailable', 'project folders need the desktop app');
  if (!listening) { bridge.onEvent(dispatch); listening = true; }
  let set = listeners.get(workspaceId);
  if (!set) { set = new Set(); listeners.set(workspaceId, set); }
  const first = set.size === 0;
  set.add(listener);
  if (first) {
    try { await bridge.subscribe(workspaceId); } catch (e) {
      set.delete(listener);
      if (set.size === 0) listeners.delete(workspaceId);
      throw e instanceof WorkspaceError ? e : new WorkspaceError('failed', 'the workspace could not be watched');
    }
  }
  return () => {
    const current = listeners.get(workspaceId);
    if (!current || !current.delete(listener)) return;
    if (current.size === 0) {
      listeners.delete(workspaceId);
      void bridge.unsubscribe(workspaceId).catch(() => {});
    }
  };
}
