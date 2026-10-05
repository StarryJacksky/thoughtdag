// The folder the open canvas works in, as the page holds it: which
// workspace that is, whether the file panel is showing, and which lost file
// is being looked for. A canvas remembers its workspace by id; the shell
// remembers the folders it was granted, so the two meet again after a
// restart without a path ever being stored here.

import { create } from 'zustand';
import { useStore } from '../../store';
import { setProjectWorkspace, useProjects } from '../../store/projects';
import { chooseRoot, listWorkspaces, openDefaultWorkspace, workspaceAvailable, WorkspaceError, workspaceWatched } from './client';
import type { WorkspaceRecord } from './contracts';
import { subscribeWorkspace } from './events';
import { documents } from '../documents/document-service';
import { canvasVisit } from './canvas-visit';
import { applyWorkspaceEvent, syncResourceNodes } from './graph-resource';

interface WorkspacePanelState {
  /** the file panel is showing */
  open: boolean;
  /** the folder the open canvas works in, when it has one and it is known */
  workspace: WorkspaceRecord | null;
  /** the canvas `workspace` belongs to: the panel never shows one canvas the folder of another */
  canvasId: string | null;
  /** the node whose lost file the person is looking for */
  relinkNodeId: string | null;
  /** goes up whenever the tree should be read again */
  treeVersion: number;
  /** a file is being created from the graph: where its type menu shows, and where its node will go */
  createAt: { screen: { x: number; y: number }; at: { x: number; y: number } } | null;
  /** workspaces that are subscribed to but whose changes are not noticed on their own: the person has to refresh */
  unwatched: string[];
}

export const useWorkspacePanel = create<WorkspacePanelState>(() => ({ open: false, workspace: null, canvasId: null, relinkNodeId: null, treeVersion: 0, createAt: null, unwatched: [] }));

export const reloadTree = (): void => useWorkspacePanel.setState((s) => ({ treeVersion: s.treeVersion + 1 }));

const activeCanvas = (): string | null => useProjects.getState().activeId;
const rememberedBy = (canvasId: string): string | undefined => useProjects.getState().projects.find((p) => p.id === canvasId)?.workspaceId;

/** Show a canvas's folder in the panel, if that canvas is the one that is open. */
function show(canvasId: string, record: WorkspaceRecord | null): void {
  if (activeCanvas() !== canvasId) return;
  useWorkspacePanel.setState((s) => ({ workspace: record, canvasId, treeVersion: s.treeVersion + 1 }));
}

/**
 * Make this the folder a canvas works in, and remember it for that canvas.
 * The canvas is named by whoever asked: a folder that took a while to open
 * belongs to the canvas it was opened for, whichever canvas is showing by
 * the time it is there.
 */
export async function bindWorkspace(record: WorkspaceRecord, canvasId: string): Promise<void> {
  show(canvasId, record);
  await setProjectWorkspace(canvasId, record.workspaceId);
}

/** The folder a canvas remembers, if the shell still has it. Looks at the canvas's own record, never at what the panel shows. */
async function folderOf(canvasId: string): Promise<WorkspaceRecord | null> {
  const wanted = rememberedBy(canvasId);
  if (!wanted) return null;
  try { return (await listWorkspaces()).find((w) => w.workspaceId === wanted) ?? null; } catch { return null; }
}

/** Let the person pick a folder for the canvas that is open now. Resolves with null when they picked none. */
export async function pickWorkspaceFolder(): Promise<WorkspaceRecord | null> {
  const canvasId = activeCanvas();
  if (!canvasId) throw new WorkspaceError('invalid-request', 'no canvas is open');
  const record = await chooseRoot();
  if (record) await bindWorkspace(record, canvasId);
  return record;
}

/** Use a canvas's own folder: the one the shell keeps for it, with no picker. The open canvas when none is named. */
export async function openCanvasFolder(canvasId: string | null = activeCanvas()): Promise<WorkspaceRecord> {
  if (!canvasId) throw new WorkspaceError('invalid-request', 'no canvas is open');
  const record = await openDefaultWorkspace(canvasId);
  await bindWorkspace(record, canvasId);
  return record;
}

/**
 * The workspace of a canvas (the open one when none is named): the folder
 * it remembers, else its own folder, opened and remembered. It is worked
 * out from the canvas's own record every time, so a canvas that was just
 * switched to is never given the folder of the canvas before it.
 */
export async function ensureWorkspace(canvasId: string | null = activeCanvas()): Promise<WorkspaceRecord> {
  if (!canvasId) throw new WorkspaceError('invalid-request', 'no canvas is open');
  const known = await folderOf(canvasId);
  if (!known) return openCanvasFolder(canvasId);
  const panel = useWorkspacePanel.getState();
  if (panel.canvasId !== canvasId || panel.workspace?.workspaceId !== known.workspaceId) show(canvasId, known);
  return known;
}

/**
 * Pick up the workspace the open canvas used last time and bring its file
 * nodes up to date. From the moment it is called the panel is this
 * canvas's: it shows no folder until this canvas's own is known. A canvas
 * whose folder the shell no longer has is left without one; its nodes say
 * their files are missing. An answer that comes back after another canvas
 * was opened, or after this one was opened again, changes nothing.
 */
export async function restoreWorkspace(): Promise<void> {
  if (!workspaceAvailable()) return;
  const canvasId = activeCanvas();
  if (!canvasId) return;
  const visit = canvasVisit();
  const wanted = rememberedBy(canvasId);
  useWorkspacePanel.setState((s) => (s.canvasId === canvasId && s.workspace?.workspaceId === wanted
    ? { relinkNodeId: null, createAt: null }
    : { workspace: null, canvasId, relinkNodeId: null, createAt: null, treeVersion: s.treeVersion + 1 }));
  const found = await folderOf(canvasId);
  // another canvas since, this one opened anew since, or the canvas was given another folder while the shell was asked
  if (canvasVisit() !== visit || activeCanvas() !== canvasId || rememberedBy(canvasId) !== wanted) return;
  const panel = useWorkspacePanel.getState();
  if (panel.workspace?.workspaceId !== found?.workspaceId) show(canvasId, found);
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
    // a file that is open for typing hears of it too: its buffer reloads, or says there is a conflict
    documents.noteWorkspaceEvent(event);
    if (useWorkspacePanel.getState().workspace?.workspaceId === event.workspaceId) reloadTree();
  }).catch(() => () => {})));
  // a folder that cannot be watched is said to be so, instead of looking as if nothing ever changes in it
  void Promise.all(workspaceIds.map(async (id) => ((await workspaceWatched(id).catch(() => true)) ? null : id)))
    .then((ids) => useWorkspacePanel.setState({ unwatched: ids.filter((id): id is string => id !== null) }));
  return () => { for (const stop of stops) stop(); };
}
