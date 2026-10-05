import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { attachEntry } from '../../src/lib/workspace/graph-resource';
import { ensureWorkspace, pickWorkspaceFolder, restoreWorkspace, useWorkspacePanel, watchWorkspaces, watchedWorkspaceIds } from '../../src/lib/workspace/session';
import { freeSpot } from '../../src/components/workspace/actions';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// The folder a canvas works in, as the page holds it, against a stand-in
// for the shell's workspace door: which folder a canvas gets, what it
// remembers of it, and what its file nodes show when it is opened again.

let shell: FakeWorkspace;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const calls = (method: string) => shell.calls.filter((c) => c.method === method);
const canvasMeta = () => useProjects.getState().projects.find((p) => p.id === 'canvas-1')!;

beforeAll(() => bootProjects());
beforeEach(() => {
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-1', switching: false });
  useWorkspacePanel.setState({ open: false, workspace: null, relinkNodeId: null, createAt: null });
});
afterEach(() => {
  shell.uninstall();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

describe('the folder a canvas works in', () => {
  it('is the canvas\'s own folder when a file is asked for and it has none yet: opened without a picker, and remembered', async () => {
    const workspace = await ensureWorkspace();
    expect(calls('openDefault').map((c) => c.args)).toEqual([['canvas-1']]);
    expect(calls('chooseRoot')).toEqual([]);
    expect(useWorkspacePanel.getState().workspace).toEqual(workspace);
    expect(canvasMeta().workspaceId).toBe(workspace.workspaceId);
  });

  it('is not asked for again once the canvas has one', async () => {
    await ensureWorkspace();
    await ensureWorkspace();
    expect(calls('openDefault').length).toBe(1);
  });

  it('is remembered by id when the person picks one', async () => {
    const picked = await pickWorkspaceFolder();
    expect(picked?.workspaceId).toBe('ws_1');
    expect(canvasMeta().workspaceId).toBe('ws_1');
    expect(JSON.stringify(canvasMeta())).not.toMatch(/[/\\]/);
  });

  it('is picked up again when the canvas is opened, from what the shell still has', async () => {
    useProjects.setState((s) => ({ projects: s.projects.map((p) => ({ ...p, workspaceId: 'ws_1' })) }));
    await restoreWorkspace();
    expect(useWorkspacePanel.getState().workspace?.workspaceId).toBe('ws_1');
    expect(calls('chooseRoot')).toEqual([]);
  });

  it('is left empty when the shell no longer has that folder', async () => {
    useProjects.setState((s) => ({ projects: s.projects.map((p) => ({ ...p, workspaceId: 'ws_gone' })) }));
    await restoreWorkspace();
    expect(useWorkspacePanel.getState().workspace).toBeNull();
  });
});

describe('a canvas opened again', () => {
  it('shows what became of its files while it was closed', async () => {
    const moved = await attachEntry('canvas-1', 'ws_1', shell.seed('notes/a.md', 'FIRST_TEXT_B3\n'), { x: 0, y: 0 });
    const edited = await attachEntry('canvas-1', 'ws_1', shell.seed('notes/b.md', 'old\n'), { x: 500, y: 0 });
    const gone = await attachEntry('canvas-1', 'ws_1', shell.seed('notes/c.md', 'kept copy\n'), { x: 1000, y: 0 });
    shell.files.get(node(moved).data.resourceRef!.fileId)!.relativePath = 'papers/a.md';
    shell.files.get(node(edited).data.resourceRef!.fileId)!.content = 'EDITED_WHILE_CLOSED_J1\n';
    shell.files.get(node(gone).data.resourceRef!.fileId)!.status = 'missing';

    await restoreWorkspace();
    expect(node(moved).data.resourceHint).toMatchObject({ relativePath: 'papers/a.md', status: 'ready' });
    expect(node(gone).data.resourceHint!.status).toBe('missing');
    expect(node(gone).data.attachments.map((a) => a.content)).toEqual(['kept copy\n']);
    await expect.poll(() => node(edited).data.attachments.map((a) => a.content)).toEqual(['EDITED_WHILE_CLOSED_J1\n']);
    expect(node(edited).data.resourceHint!.revision).toBe(fakeRevision('EDITED_WHILE_CLOSED_J1\n'));
  });

  it('shows a file as missing when no open workspace knows it any more, and keeps its copy', async () => {
    const id = await attachEntry('canvas-1', 'ws_1', shell.seed('notes/a.md', 'FIRST_TEXT_B3\n'), { x: 0, y: 0 });
    shell.failNext('reconcile', 'unknown-file', 'that file is not known to an open workspace');
    await restoreWorkspace();
    expect(node(id).data.resourceHint!.status).toBe('missing');
    expect(node(id).data.attachments.map((a) => a.content)).toEqual(['FIRST_TEXT_B3\n']);
  });
});

describe('what a canvas listens to', () => {
  it('is its own folder and every workspace its file nodes are in', async () => {
    await pickWorkspaceFolder();
    await attachEntry('canvas-1', 'ws_other', shell.seed('report.md', 'x', 'ws_other'), { x: 0, y: 0 });
    expect(watchedWorkspaceIds()).toEqual(['ws_1', 'ws_other']);
  });

  it('brings nodes up to date and has the tree read again when its own folder changes', async () => {
    await pickWorkspaceFolder();
    const id = await attachEntry('canvas-1', 'ws_1', shell.seed('notes/a.md', 'FIRST_TEXT_B3\n'), { x: 0, y: 0 });
    const stop = await watchWorkspaces(watchedWorkspaceIds());
    const before = useWorkspacePanel.getState().treeVersion;
    shell.editExternally(node(id).data.resourceRef!.fileId, 'EXTERNAL_EDIT_E6\n');
    await expect.poll(() => node(id).data.attachments.map((a) => a.content)).toEqual(['EXTERNAL_EDIT_E6\n']);
    expect(useWorkspacePanel.getState().treeVersion).toBeGreaterThan(before);
    stop();
    expect(calls('unsubscribe').map((c) => c.args)).toEqual([['ws_1']]);
  });
});

describe('where a new card goes', () => {
  const card = (id: string, x: number, y: number) => ({ id, type: 'thought' as const, position: { x, y }, width: 400, height: 240, data: { question: '', response: '', responses: [], responseIndex: 0, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off' as const, roleMode: 'inherit' as const, attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], isRoot: true, isBranch: false } });
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x < b.x + 400 && a.x + 400 > b.x && a.y < b.y + 240 && a.y + 240 > b.y;

  it('is the place asked for when nothing is there', () => {
    expect(freeSpot({ x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it('is beside what is already there, never on top of it', () => {
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 9; i++) {
      const spot = freeSpot({ x: 100, y: 100 });
      for (const other of placed) expect(overlaps(spot, other), `${JSON.stringify(spot)} on ${JSON.stringify(other)}`).toBe(false);
      placed.push(spot);
      useStore.setState((s) => ({ nodes: [...s.nodes, card(`n${i}`, spot.x, spot.y)] }));
    }
  });
});
