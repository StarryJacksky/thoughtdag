import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';
import { useProjects } from '../../src/store/projects';
import { addNodeFor, createDocument } from '../../src/lib/workspace/create-command';
import { QUICK_FILE_TYPES, fileTypeOf, isValidExtension, lastFileType } from '../../src/lib/workspace/file-types';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// Creating a file from the two places it can be asked for, against a
// stand-in for the shell's workspace door. What is checked is what each
// entry does to the workspace and to the canvas, and what neither does.

let shell: FakeWorkspace;
let fetches: number;

beforeEach(() => {
  shell = installFakeWorkspace();
  fetches = 0;
  vi.stubGlobal('fetch', () => { fetches++; return Promise.reject(new Error('no network in tests')); });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-1', switching: false });
});
afterEach(() => {
  shell.uninstall();
  vi.unstubAllGlobals();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  localStorage.clear();
});

const created = () => shell.calls.filter((c) => c.method === 'createFile').map((c) => c.args[0] as { origin: string; parentId?: string; extension: string });

describe('a file asked for from the workspace tree', () => {
  it('lands in the selected folder and leaves the canvas untouched', async () => {
    const result = await createDocument({ workspaceId: 'ws_1', parentId: shell.entryId('notes'), extension: 'md', origin: 'workspace' });
    expect(created()).toMatchObject([{ origin: 'workspace', parentId: shell.entryId('notes'), extension: 'md' }]);
    expect(result.record.relativePath).toBe('notes/Untitled-001.md');
    expect(result.nodeId).toBeNull();
    expect(useStore.getState().nodes).toEqual([]);
    expect(useStore.getState().edges).toEqual([]);
  });
});

describe('a file asked for from the graph', () => {
  it('lands in Graph Files and puts exactly one node referencing it where the person pointed, wired to nothing', async () => {
    const result = await createDocument({ workspaceId: 'ws_1', extension: 'tex', origin: 'graph', graphId: 'canvas-1', position: { x: 120, y: 80 } });
    expect(created()).toMatchObject([{ origin: 'graph', extension: 'tex' }]);
    expect(result.record.relativePath).toBe('Graph Files/Untitled-001.tex');
    const { nodes, edges } = useStore.getState();
    expect(nodes.length).toBe(1);
    expect(nodes[0].id).toBe(result.nodeId);
    expect(nodes[0].position).toEqual({ x: 120, y: 80 });
    expect(nodes[0].data.stepKind).toBe('file');
    expect(nodes[0].data.resourceRef).toEqual({ fileId: result.record.fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' });
    expect(nodes[0].data.resourceHint).toMatchObject({ workspaceId: 'ws_1', name: 'Untitled-001.tex', relativePath: 'Graph Files/Untitled-001.tex', status: 'ready' });
    expect(edges).toEqual([]);
  });

  it('needs the canvas and a place on it, and creates nothing without them', async () => {
    await expect(createDocument({ workspaceId: 'ws_1', extension: 'md', origin: 'graph' })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(created()).toEqual([]);
  });

  it('keeps the file when its node cannot be made, and the node can be added afterwards without creating again', async () => {
    const result = await createDocument({ workspaceId: 'ws_1', extension: 'md', origin: 'graph', graphId: 'another-canvas', position: { x: 0, y: 0 } });
    expect(result.nodeId).toBeNull();
    expect(result.nodeError).toMatch(/not the one that is open/);
    expect(shell.files.size).toBe(1);
    expect(useStore.getState().nodes).toEqual([]);
    const nodeId = await addNodeFor(result.record, 'canvas-1', { x: 10, y: 20 });
    expect(useStore.getState().nodes.map((n) => n.id)).toEqual([nodeId]);
    expect(created().length).toBe(1);
  });
});

describe('either entry', () => {
  it('calls no model and needs no network', async () => {
    await createDocument({ workspaceId: 'ws_1', extension: 'md', origin: 'workspace' });
    await createDocument({ workspaceId: 'ws_1', extension: 'md', origin: 'graph', graphId: 'canvas-1', position: { x: 0, y: 0 } });
    expect(fetches).toBe(0);
    expect(window.desktopAgents).toBeUndefined();
  });

  it('asks the shell once per creation, each with an operation id of its own', async () => {
    await createDocument({ workspaceId: 'ws_1', extension: 'md', origin: 'workspace' });
    await createDocument({ workspaceId: 'ws_1', extension: 'md', origin: 'workspace' });
    const keys = shell.calls.filter((c) => c.method === 'createFile').map((c) => (c.args[0] as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect([...shell.files.values()].map((f) => f.relativePath).sort()).toEqual(['Untitled-001.md', 'Untitled-002.md']);
  });

  it('remembers the type for next time', async () => {
    expect(lastFileType()).toBe('md');
    await createDocument({ workspaceId: 'ws_1', extension: 'tex', origin: 'workspace' });
    expect(lastFileType()).toBe('tex');
  });

  it('refuses an extension that is not one, before the shell is asked', async () => {
    await expect(createDocument({ workspaceId: 'ws_1', extension: '../sh', origin: 'workspace' })).rejects.toMatchObject({ code: 'invalid-request' });
    expect(created()).toEqual([]);
  });
});

describe('the file types on offer', () => {
  it('name each extension once', () => {
    const extensions = QUICK_FILE_TYPES.map((t) => t.extension);
    expect(new Set(extensions).size).toBe(extensions.length);
    expect(extensions).toEqual(['md', 'txt', 'tex', 'py', 'json', 'yaml', 'csv', 'html', 'js', 'ts', 'bib', 'tdmap']);
  });

  it('find a listed type whatever its case, and say nothing for one typed in by hand', () => {
    expect(fileTypeOf('MD')?.editorKind).toBe('markdown');
    expect(fileTypeOf('tdmap')?.editorKind).toBe('mindmap');
    expect(fileTypeOf('toml')).toBeNull();
  });

  it('accept a plain extension and refuse a dot, a path or nothing', () => {
    for (const ok of ['md', 'toml', 'R', 'h5', 'tar_gz']) expect(isValidExtension(ok), ok).toBe(true);
    for (const bad of ['', '.md', 'a.b', '../sh', 'a/b', 'a b', 'x'.repeat(17)]) expect(isValidExtension(bad), bad).toBe(false);
  });
});
