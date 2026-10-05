// The folder the open canvas works in, as the page holds it: which
// workspace that is, whether the file panel is showing, and which lost file
// is being looked for. A canvas remembers its workspace by id; the shell
// remembers the folders it was granted, so the two meet again after a
// restart without a path ever being stored here.

import { create } from 'zustand';
import { useStore } from '../../store';
import { setProjectWorkspace, useProjects } from '../../store/projects';
import { chooseRoot, listWorkspaces, openDefaultWorkspace, workspaceAvailable, WorkspaceError } from './client';
import type { WorkspaceRecord } from './contracts';
import { subscribeWorkspace } from './events';
import { applyWorkspaceEvent, syncResourceNodes } from './graph-resource';

interface WorkspacePanelState {
  /** the file panel is showing */
  open: boolean;
  /** the folder the open canvas works in, when it has one */
  workspace: WorkspaceRecord | null;
  /** the node whose lost file the person is looking for */
  relinkNodeId: string | null;
  /** goes up whenever the tree should be read again */
  treeVersion: number;
  /** a file is being created from the graph: where its type menu shows, and where its node will go */
  createAt: { screen: { x: number; y: number }; at: { x: number; y: number } } | null;
}

export const useWorkspacePanel = create<WorkspacePanelState>(() => ({ open: false, workspace: null, relinkNodeId: null, treeVersion: 0, createAt: null }));

export const reloadTree = (): void => useWorkspacePanel.setState((s) => ({ treeVersion: s.treeVersion + 1 }));

/** Make this the folder the open canvas works in, and remember it for the canvas. */
export async function bindWorkspace(record: WorkspaceRecord): Promise<void> {
  useWorkspacePanel.setState((s) => ({ workspace: record, treeVersion: s.treeVersion + 1 }));
  const canvasId = useProjects.getState().activeId;
  if (canvasId) await setProjectWorkspace(canvasId, record.workspaceId);
}

/** Let the person pick a folder. Resolves with null when they picked none. */
export async function pickWorkspaceFolder(): Promise<WorkspaceRecord | null> {
  const record = await chooseRoot();
  if (record) await bindWorkspace(record);
  return record;
}

/** Use the canvas's own folder: the one the shell keeps for it, with no picker. */
export async function openCanvasFolder(): Promise<WorkspaceRecord> {
  const canvasId = useProjects.getState().activeId;
  if (!canvasId) throw new WorkspaceError('invalid-request', 'no canvas is open');
  const record = await openDefaultWorkspace(canvasId);
  await bindWorkspace(record);
  return record;
}

/** The open canvas's workspace; its own folder is opened when it has none yet. */
export async function ensureWorkspace(): Promise<WorkspaceRecord> {
  return useWorkspacePanel.getState().workspace ?? openCanvasFolder();
}

/**
 * Pick up the workspace the open canvas used last time and bring its file
 * nodes up to date. A canvas whose folder the shell no longer has is left
 * without one; its nodes say their files are missing.
 */
export async function restoreWorkspace(): Promise<void> {
  if (!workspaceAvailable()) return;
  const { projects, activeId } = useProjects.getState();
  const wanted = projects.find((p) => p.id === activeId)?.workspaceId;
  let found: WorkspaceRecord | null = null;
  if (wanted) {
    try { found = (await listWorkspaces()).find((w) => w.workspaceId === wanted) ?? null; } catch { /* stays without one */ }
  }
  // the canvas may have been switched again while the shell was asked
  if (useProjects.getState().activeId !== activeId) return;
  useWorkspacePanel.setState((s) => ({ workspace: found, relinkNodeId: null, treeVersion: s.treeVersion + 1 }));
  await syncResourceNodes();
}

/** Every workspace the open canvas has to hear from: its own, and those its file nodes are in. */
export function watchedWorkspaceIds(): string[] {
  const ids = new Set<string>();
  const bound = useWorkspacePanel.getState().workspace?.workspaceId;
  if (bound) ids.add(bound);
  for (const n of useStore.getState().nodes) if (n.data.resourceHint) ids.add(n.data.resourceHint.workspaceId);
  return [...ids].sort();
}

/**
 * Hear about changes in these workspaces: nodes that reference a changed
 * file are brought up to date, and the tree is read again when the change
 * is in the folder it shows. Resolves with the function that stops it.
 */
export async function watchWorkspaces(workspaceIds: string[]): Promise<() => void> {
  const stops = await Promise.all(workspaceIds.map((id) => subscribeWorkspace(id, (event) => {
    applyWorkspaceEvent(event);
    if (useWorkspacePanel.getState().workspace?.workspaceId === event.workspaceId) reloadTree();
  }).catch(() => () => {})));
  return () => { for (const stop of stops) stop(); };
}
