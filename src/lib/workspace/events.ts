// Changes to a workspace's registered files, as the renderer hears them:
// this application's own operations (the event names the operation) and
// other programs' edits, renames and deletions (it names none).
//
// The shell pushes every event on one channel. This module listens once,
// checks each event against the contract, and hands it to whoever
// subscribed to that workspace. The shell is asked to watch a workspace
// when its first listener arrives and to stop when its last one leaves.
//
// Several listeners may arrive while the shell is still being asked. They
// all wait for that one asking: if it fails, every one of them fails and
// none is left believing it is subscribed, and the next to arrive asks the
// shell again.

import { validateDTO, type WorkspaceEvent } from './contracts';
import { WorkspaceError } from './client';

export type WorkspaceListener = (event: WorkspaceEvent) => void;

const listeners = new Map<string, Set<WorkspaceListener>>();
const asking = new Map<string, Promise<void>>(); // the shell is being asked to watch this workspace
const watched = new Set<string>();               // the shell has said it is watching
let listening = false;

function dispatch(raw: unknown) {
  const result = validateDTO('WorkspaceEvent', raw);
  // an event this version cannot read is dropped: acting on half-understood news is worse than missing it
  if (!result.ok) return;
  for (const listener of listeners.get(result.value.workspaceId) ?? []) {
    try { listener(result.value); } catch { /* one listener's failure stops nobody else */ }
  }
}

/** Have the shell watch a workspace: once, however many are waiting for it. */
function watch(bridge: DesktopWorkspaceBridge, workspaceId: string): Promise<void> {
  if (watched.has(workspaceId)) return Promise.resolve();
  let pending = asking.get(workspaceId);
  if (!pending) {
    pending = (async () => {
      try { await bridge.subscribe(workspaceId); } finally { asking.delete(workspaceId); }
      watched.add(workspaceId);
      // everyone who was waiting may have left in the meantime
      stopIfUnheard(bridge, workspaceId);
    })();
    asking.set(workspaceId, pending);
  }
  return pending;
}

function stopIfUnheard(bridge: DesktopWorkspaceBridge, workspaceId: string) {
  if (listeners.get(workspaceId)?.size || !watched.has(workspaceId)) return;
  watched.delete(workspaceId);
  void bridge.unsubscribe(workspaceId).catch(() => {});
}

/**
 * Hear about changes to a workspace's registered files. Resolves with the
 * function that stops listening, once the shell is watching the workspace;
 * rejects, with nothing left subscribed, when the shell could not.
 */
export async function subscribeWorkspace(workspaceId: string, listener: WorkspaceListener): Promise<() => void> {
  const bridge = typeof window !== 'undefined' ? window.desktopWorkspace : undefined;
  if (!bridge) throw new WorkspaceError('unavailable', 'project folders need the desktop app');
  if (!listening) { bridge.onEvent(dispatch); listening = true; }
  let set = listeners.get(workspaceId);
  if (!set) { set = new Set(); listeners.set(workspaceId, set); }
  set.add(listener);
  const leave = () => {
    const current = listeners.get(workspaceId);
    if (!current || !current.delete(listener)) return;
    if (current.size === 0) listeners.delete(workspaceId);
    stopIfUnheard(bridge, workspaceId);
  };
  try { await watch(bridge, workspaceId); } catch (e) {
    leave();
    throw e instanceof WorkspaceError ? e : new WorkspaceError('failed', 'the workspace could not be watched');
  }
  return leave;
}
