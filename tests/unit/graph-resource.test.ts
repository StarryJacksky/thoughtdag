import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { buildContext } from '../../src/store/context-builder';
import { applyWorkspaceEvent, attachEntry, attachResource, copyAcrossWorkspaces, keepCopiesOutOfHistory, moveReferencedFile, nodesOfFile, parseDragPayload, refreshResourceNode, relinkNode, syncResourceNodes } from '../../src/lib/workspace/graph-resource';
import { subscribeWorkspace } from '../../src/lib/workspace/events';
import { installFakeWorkspace, fakeRevision, type FakeWorkspace } from '../helpers/fake-workspace';

// Real workspace files on the canvas, against a stand-in for the shell's
// workspace door: what a node referencing a file holds, what happens to the
// nodes when the file changes, and what never happens to the file because
// of something done to a node.

let shell: FakeWorkspace;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const copyOf = (id: string) => node(id).data.attachments.map((a) => a.content);
const calls = (method: string) => shell.calls.filter((c) => c.method === method);

// The canvas is loaded before anything is put on it, as it is in the app.
// Without this the first node deletion starts that load itself, and it lands
// in whichever test is running by then and empties its canvas.
beforeAll(() => bootProjects());

beforeEach(() => {
  shell = installFakeWorkspace();
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'canvas-1', name: 'canvas', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-1', switching: false });
});
afterEach(() => {
  shell.uninstall();
  vi.unstubAllGlobals();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

const place = (entryId: string, x = 0) => attachEntry('canvas-1', 'ws_1', entryId, { x, y: 0 });

describe('a node that references a workspace file', () => {
  it('carries the file\'s identity, a hint of where it is, and a copy of its content', async () => {
    const id = await place(shell.seed('notes/a.md', 'FIRST_TEXT_B3\n'));
    const fileId = node(id).data.resourceRef!.fileId;
    expect(node(id).data.resourceRef).toEqual({ fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' });
    expect(node(id).data.resourceHint).toEqual({ workspaceId: 'ws_1', name: 'a.md', relativePath: 'notes/a.md', status: 'ready', revision: fakeRevision('FIRST_TEXT_B3\n') });
    expect(node(id).data.attachments.map((a) => [a.name, a.content])).toEqual([['a.md', 'FIRST_TEXT_B3\n']]);
    expect(useStore.getState().edges).toEqual([]);
  });

  it('feeds its content into a question only once it is wired to it', async () => {
    const id = await place(shell.seed('notes/a.md', 'FIRST_TEXT_B3\n'));
    const ask = { id: 'ask', type: 'thought' as const, position: { x: 0, y: 300 }, data: { ...node(id).data, stepKind: undefined, resourceRef: undefined, resourceHint: undefined, attachments: [], question: 'What does it say?' } };
    useStore.setState((st) => ({ nodes: [...st.nodes, ask] }));
    const unwired = buildContext('ask', useStore.getState().nodes, useStore.getState().edges).messages.map((m) => m.content).join('\n');
    expect(unwired).not.toContain('FIRST_TEXT_B3');
    useStore.setState({ edges: [{ id: 'e1', source: id, target: 'ask' }] });
    const wired = buildContext('ask', useStore.getState().nodes, useStore.getState().edges).messages.map((m) => m.content).join('\n');
    expect(wired).toContain('FIRST_TEXT_B3');
  });

  it('shares the identity with every other node that references the same file', async () => {
    const entry = shell.seed('notes/a.md', 'FIRST_TEXT_B3\n');
    const one = await place(entry, 0);
    const two = await place(entry, 500);
    expect(one).not.toBe(two);
    expect(node(one).data.resourceRef!.fileId).toBe(node(two).data.resourceRef!.fileId);
    expect(nodesOfFile(node(one).data.resourceRef!.fileId).map((n) => n.id).sort()).toEqual([one, two].sort());
  });

  it('can be deleted without the file being touched, and the other references stay', async () => {
    const entry = shell.seed('notes/a.md', 'FIRST_TEXT_B3\n');
    const one = await place(entry, 0);
    const two = await place(entry, 500);
    const fileId = node(one).data.resourceRef!.fileId;
    useStore.getState().deleteNode(one);
    expect(useStore.getState().nodes.map((n) => n.id)).toEqual([two]);
    expect(calls('trashFile')).toEqual([]);
    expect(calls('moveFile')).toEqual([]);
    expect(shell.files.get(fileId)).toMatchObject({ status: 'ready', content: 'FIRST_TEXT_B3\n' });
  });

  it('is refused on a canvas that is not the one open, and for a reference that is not to that file', async () => {
    const entry = shell.seed('notes/a.md', 'x');
    await expect(attachEntry('another-canvas', 'ws_1', entry, { x: 0, y: 0 })).rejects.toMatchObject({ code: 'wrong-graph' });
    const record = shell.record([...shell.files.keys()][0]);
    await expect(attachResource('canvas-1', { fileId: 'file_other', selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }, { x: 0, y: 0 }, record)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(useStore.getState().nodes).toEqual([]);
  });

  it('keeps the reference and takes no copy of a file that is not text', async () => {
    const entry = shell.seed('data/blob.bin', '�');
    const fileId = [...shell.files.keys()][0];
    const original = window.desktopWorkspace!.readBytes;
    window.desktopWorkspace!.readBytes = async () => ({ bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x80]), revision: fakeRevision('binary') });
    const id = await place(entry);
    window.desktopWorkspace!.readBytes = original;
    expect(node(id).data.resourceRef!.fileId).toBe(fileId);
    expect(node(id).data.attachments).toEqual([]);
  });
});

describe('when the workspace reports a change to the file', () => {
  async function watched() {
    const entry = shell.seed('notes/a.md', 'FIRST_TEXT_B3\n');
    const one = await place(entry, 0);
    const two = await place(entry, 500);
    const stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
    return { one, two, fileId: node(one).data.resourceRef!.fileId, stop };
  }

  it('an edit by another program refreshes the copy in every node that references it', async () => {
    const { one, two, fileId, stop } = await watched();
    shell.editExternally(fileId, 'EXTERNAL_EDIT_E6\n');
    await vi.waitFor(() => expect(copyOf(one)).toEqual(['EXTERNAL_EDIT_E6\n']));
    await vi.waitFor(() => expect(copyOf(two)).toEqual(['EXTERNAL_EDIT_E6\n']));
    expect(node(one).data.resourceHint!.revision).toBe(fakeRevision('EXTERNAL_EDIT_E6\n'));
    stop();
  });

  it('a file that went missing is shown as missing, and its last copy is kept', async () => {
    const { one, two, fileId, stop } = await watched();
    shell.files.get(fileId)!.status = 'missing';
    shell.emit({ workspaceId: 'ws_1', fileId, change: 'missing', observedRevision: null, opId: null, record: shell.record(fileId) });
    expect(node(one).data.resourceHint!.status).toBe('missing');
    expect(node(two).data.resourceHint!.status).toBe('missing');
    expect(copyOf(one)).toEqual(['FIRST_TEXT_B3\n']);
    stop();
  });

  it('a file moved by another program shows its new place; the nodes do not move', async () => {
    const { one, fileId, stop } = await watched();
    const before = node(one).position;
    shell.files.get(fileId)!.relativePath = 'papers/renamed.md';
    shell.emit({ workspaceId: 'ws_1', fileId, change: 'moved', observedRevision: fakeRevision('FIRST_TEXT_B3\n'), opId: null, record: shell.record(fileId) });
    expect(node(one).data.resourceHint).toMatchObject({ name: 'renamed.md', relativePath: 'papers/renamed.md', status: 'ready' });
    expect(node(one).position).toEqual(before);
    stop();
  });
});

describe('moving the file a node references', () => {
  it('goes through the workspace by file id, and every node that references it shows the new place', async () => {
    const entry = shell.seed('Graph Files/Untitled-001.md', 'x');
    const one = await place(entry, 0);
    const two = await place(entry, 500);
    const fileId = node(one).data.resourceRef!.fileId;
    const moved = await moveReferencedFile(one, shell.entryId('notes'));
    expect(moved.fileId).toBe(fileId);
    expect(calls('moveFile').map((c) => c.args.slice(0, 3))).toEqual([[fileId, shell.entryId('notes'), 'Untitled-001.md']]);
    for (const id of [one, two]) expect(node(id).data.resourceHint).toMatchObject({ relativePath: 'notes/Untitled-001.md', name: 'Untitled-001.md' });
    expect(node(one).data.resourceRef!.fileId).toBe(fileId);
  });

  it('leaves the nodes showing where the file is when the move does not happen', async () => {
    const entry = shell.seed('Graph Files/Untitled-001.md', 'x');
    shell.seed('notes/Untitled-001.md', 'already here');
    const one = await place(entry);
    await expect(moveReferencedFile(one, shell.entryId('notes'))).rejects.toMatchObject({ code: 'exists' });
    expect(node(one).data.resourceHint!.relativePath).toBe('Graph Files/Untitled-001.md');
  });

  it('is not something a node without a file can do', async () => {
    useStore.setState({ nodes: [{ id: 'plain', type: 'thought', position: { x: 0, y: 0 }, data: { question: 'q', response: '', responses: [], responseIndex: 0, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off', roleMode: 'inherit', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], isRoot: true, isBranch: false } }] });
    await expect(moveReferencedFile('plain', undefined)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(calls('moveFile')).toEqual([]);
  });
});

describe('finding a lost file again', () => {
  it('the person picks the file it is now; the node is live again with that content', async () => {
    const id = await place(shell.seed('notes/a.md', 'FIRST_TEXT_B3\n'));
    const fileId = node(id).data.resourceRef!.fileId;
    shell.files.get(fileId)!.status = 'missing';
    applyWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'missing', observedRevision: null, opId: null, record: shell.record(fileId) });
    const candidate = shell.seed('papers/found.md', 'FOUND_AGAIN_S1\n');
    const record = await relinkNode(id, candidate);
    expect(record.fileId).toBe(fileId);
    expect(node(id).data.resourceHint).toMatchObject({ status: 'ready', relativePath: 'papers/found.md' });
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['FOUND_AGAIN_S1\n']));
  });
});

describe('a file from another workspace', () => {
  it('comes in as a copy with a new identity, marked with where it came from; the original is untouched', async () => {
    shell.seed('report.md', 'OTHER_WORKSPACE_T2\n', 'ws_other');
    const sourceId = [...shell.files.keys()][0];
    const copy = await copyAcrossWorkspaces(sourceId, 'report.md', { workspaceId: 'ws_1', parentId: shell.entryId('notes') });
    expect(copy.fileId).not.toBe(sourceId);
    expect(copy).toMatchObject({ workspaceId: 'ws_1', relativePath: 'notes/report.md', origin: 'import', importedFrom: { source: 'other', note: 'report.md' } });
    expect(shell.files.get(sourceId)).toMatchObject({ workspaceId: 'ws_other', relativePath: 'report.md', status: 'ready' });
    expect(calls('moveFile')).toEqual([]);
    expect(calls('trashFile')).toEqual([]);
  });
});

describe('what a drag carries', () => {
  it('is a file, a selection or a graph node, by id', () => {
    expect(parseDragPayload(JSON.stringify({ kind: 'file-ref', workspaceId: 'ws_1', entryId: 'e_notes/a.md', name: 'a.md' }))).toEqual({ kind: 'file-ref', workspaceId: 'ws_1', entryId: 'e_notes/a.md', name: 'a.md' });
    expect(parseDragPayload(JSON.stringify({ kind: 'graph-node', nodeId: 'n1' }))).toEqual({ kind: 'graph-node', nodeId: 'n1' });
    const ref = { fileId: 'file_1', selector: { kind: 'text', quote: 'the trimmed mean', prefix: '', suffix: '' }, version: { kind: 'live' }, payload: 'text' };
    expect(parseDragPayload(JSON.stringify({ kind: 'selection-ref', workspaceId: 'ws_1', name: 'a.md', ref }))?.kind).toBe('selection-ref');
  });

  it('is refused when it names a path, has a kind nobody defined, or is malformed', () => {
    for (const bad of [
      { kind: 'file-ref', workspaceId: 'ws_1', entryId: 'e_a', name: 'a.md', path: '/etc/passwd' },
      { kind: 'file-ref', workspaceId: 'ws_1', name: 'a.md' },
      { kind: 'file-path', path: '/synthetic/project/a.md' },
      { kind: 'graph-node', nodeId: '' },
      { kind: 'selection-ref', workspaceId: 'ws_1', name: 'a.md', ref: { fileId: 'file_1', selector: { kind: 'lines', from: 1, to: 2 }, version: { kind: 'live' }, payload: 'text' } },
      ['file-ref'], 'file-ref', null,
    ]) expect(parseDragPayload(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    expect(parseDragPayload('not json')).toBeNull();
  });
});

describe('a canvas saved before nodes could reference files', () => {
  it('is left exactly as it was: its attachment nodes are not files, and the workspace is not asked about them', async () => {
    const legacy = { id: 'old-file-node', type: 'thought' as const, position: { x: 0, y: 0 }, data: { question: '', stepKind: 'file' as const, response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'tag' as const, roleMode: 'inherit' as const, attachments: [{ id: 'att-1', name: 'paper.md', type: 'text/plain', size: 12, content: 'OLD_PAPER_V9', addedAt: '2026-01-01T00:00:00Z' }], excludedAttachmentIds: [], includedAttachmentIds: [], isRoot: false, isBranch: false } };
    useStore.setState({ nodes: [legacy] });
    await syncResourceNodes();
    applyWorkspaceEvent({ workspaceId: 'ws_1', fileId: 'file_unrelated', change: 'missing', observedRevision: null, opId: null, record: { fileId: 'file_unrelated', workspaceId: 'ws_1', relativePath: 'x.md', locator: { kind: 'local', rootGrantId: 'grant_1', relativePath: 'x.md' }, sourceRevision: null, mediaType: 'text/plain', origin: 'workspace', status: 'missing', revision: null } });
    expect(useStore.getState().nodes).toEqual([legacy]);
    expect(shell.calls).toEqual([]);
  });
});

// ── what the review of M1 found ────────────────────────────────────────

const turn = (id: string, more: Record<string, unknown> = {}) => ({ id, type: 'thought' as const, position: { x: 0, y: 300 }, data: { question: `question of ${id}`, response: '', responses: [], responseIndex: 0, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off' as const, roleMode: 'inherit' as const, attachments: [], excludedAttachmentIds: [] as string[], includedAttachmentIds: [] as string[], isRoot: false, isBranch: false, ...more } });
const contextOf = (id: string) => {
  const { nodes, edges } = useStore.getState();
  const target = nodes.find((n) => n.id === id)!;
  return buildContext(id, nodes, edges, undefined, target.data.excludedAttachmentIds, target.data.includedAttachmentIds).messages.map((m) => m.content).join('\n');
};
const attachmentId = (id: string) => node(id).data.attachments[0].id;

describe('a choice made about a file node\'s content, when the file changes', () => {
  it('a file left out of a question stays left out after another program edits it', async () => {
    const id = await place(shell.seed('notes/a.md', 'OLD_BODY_L1\n'));
    const stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
    useStore.setState((st) => ({ nodes: [...st.nodes, turn('ask', { excludedAttachmentIds: [attachmentId(id)] })], edges: [{ id: 'e1', source: id, target: 'ask' }] }));
    expect(contextOf('ask')).not.toContain('OLD_BODY_L1');

    const before = attachmentId(id);
    shell.editExternally(node(id).data.resourceRef!.fileId, 'NEW_BODY_L2\n');
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['NEW_BODY_L2\n']));
    expect(attachmentId(id), 'the copy is the same attachment with new content').toBe(before);
    expect(contextOf('ask')).not.toContain('NEW_BODY_L2');
    stop();
  });

  it('a file left out further up the chain stays left out below, and a question that took it back in still has it', async () => {
    const id = await place(shell.seed('notes/a.md', 'OLD_BODY_L1\n'));
    const stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
    const att = attachmentId(id);
    useStore.setState((st) => ({
      nodes: [...st.nodes, turn('upper', { excludedAttachmentIds: [att] }), turn('lower'), turn('lower-again', { includedAttachmentIds: [att] })],
      edges: [{ id: 'e1', source: id, target: 'upper' }, { id: 'e2', source: 'upper', target: 'lower' }, { id: 'e3', source: 'upper', target: 'lower-again' }],
    }));
    expect(contextOf('lower')).not.toContain('OLD_BODY_L1');
    expect(contextOf('lower-again')).toContain('OLD_BODY_L1');

    shell.editExternally(node(id).data.resourceRef!.fileId, 'NEW_BODY_L2\n');
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['NEW_BODY_L2\n']));
    expect(contextOf('lower')).not.toContain('NEW_BODY_L2');
    expect(contextOf('lower-again')).toContain('NEW_BODY_L2');
    stop();
  });

  it('the copy stays the same attachment through a save from the app and through finding a lost file again', async () => {
    const id = await place(shell.seed('notes/a.md', 'OLD_BODY_L1\n'));
    const stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
    const fileId = node(id).data.resourceRef!.fileId;
    const att = attachmentId(id);
    await window.desktopWorkspace!.saveText(fileId, fakeRevision('OLD_BODY_L1\n'), 'SAVED_BODY_L3\n', 'op-save');
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['SAVED_BODY_L3\n']));
    expect(attachmentId(id)).toBe(att);

    shell.files.get(fileId)!.status = 'missing';
    applyWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'missing', observedRevision: null, opId: null, record: shell.record(fileId) });
    await relinkNode(id, shell.seed('papers/found.md', 'FOUND_AGAIN_S1\n'));
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['FOUND_AGAIN_S1\n']));
    expect(attachmentId(id)).toBe(att);
    stop();
  });

  it('how the person chose to have the copy shown is kept when its content is replaced', async () => {
    const id = await place(shell.seed('notes/a.md', 'OLD_BODY_L1\n'));
    const stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
    useStore.getState().setAttachmentRenderMode(id, attachmentId(id), 'text-only');
    shell.editExternally(node(id).data.resourceRef!.fileId, 'NEW_BODY_L2\n');
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['NEW_BODY_L2\n']));
    expect(node(id).data.attachments[0].renderMode).toBe('text-only');
    stop();
  });
});

describe('undoing something on the canvas after a file changed', () => {
  let stopHistory: () => void;
  beforeEach(() => { stopHistory = keepCopiesOutOfHistory(); });
  afterEach(() => stopHistory());

  async function movedThenEdited() {
    const id = await place(shell.seed('notes/a.md', 'OLD_BODY_L1\n'));
    const stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
    const st = useStore.getState();
    // the person moves the node: a step in the history
    st.pushHistory();
    useStore.setState((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, position: { x: 700, y: 40 } } : n)) }));
    useStore.getState().pushHistory();
    // then another program edits the file
    shell.editExternally(node(id).data.resourceRef!.fileId, 'NEW_BODY_L2\n');
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['NEW_BODY_L2\n']));
    return { id, stop };
  }

  it('takes back the move and not the file\'s content: the node shows what the file holds now', async () => {
    const { id, stop } = await movedThenEdited();
    useStore.getState().undo();
    expect(node(id).position).toEqual({ x: 0, y: 0 });
    expect(copyOf(id)).toEqual(['NEW_BODY_L2\n']);
    expect(node(id).data.resourceHint!.revision).toBe(fakeRevision('NEW_BODY_L2\n'));
    useStore.getState().redo();
    expect(node(id).position).toEqual({ x: 700, y: 40 });
    expect(copyOf(id)).toEqual(['NEW_BODY_L2\n']);
    stop();
  });

  it('brings back a deleted node with what its file holds now, and where its file is now', async () => {
    const id = await place(shell.seed('notes/a.md', 'OLD_BODY_L1\n'));
    const stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
    const fileId = node(id).data.resourceRef!.fileId;
    useStore.getState().deleteNode(id);
    expect(useStore.getState().nodes).toEqual([]);
    // while no node references it, the file is edited and moved
    shell.files.get(fileId)!.content = 'NEW_BODY_L2\n';
    shell.files.get(fileId)!.relativePath = 'papers/a.md';
    useStore.getState().undo();
    expect(node(id)).toBeDefined();
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['NEW_BODY_L2\n']));
    expect(node(id).data.resourceHint).toMatchObject({ relativePath: 'papers/a.md', revision: fakeRevision('NEW_BODY_L2\n') });
    stop();
  });

  it('does not make the refresh itself a step to undo', async () => {
    const { id, stop } = await movedThenEdited();
    const steps = useStore.getState().history.length;
    shell.editExternally(node(id).data.resourceRef!.fileId, 'NEWER_BODY_L4\n');
    await vi.waitFor(() => expect(copyOf(id)).toEqual(['NEWER_BODY_L4\n']));
    expect(useStore.getState().history.length).toBe(steps);
    stop();
  });
});

describe('a read that comes back after the canvas was switched', () => {
  const two = () => useProjects.setState({ projects: [{ id: 'canvas-1', name: 'A', createdAt: 0, updatedAt: 0 }, { id: 'canvas-2', name: 'B', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-1', switching: false });
  const switchTo = (id: string, nodes: ReturnType<typeof useStore.getState>['nodes']) => {
    useProjects.setState({ switching: true });
    useStore.setState({ nodes, edges: [] });
    useProjects.setState({ activeId: id, switching: false });
  };

  it('does not land on a node of the other canvas that happens to have the same node id', async () => {
    two();
    const id = await place(shell.seed('notes/a.md', 'FILE_ONE_R1\n'));
    const onA = structuredClone(useStore.getState().nodes);
    // canvas-2 was imported from a copy: the same node id, another file
    shell.seed('papers/other.md', 'FILE_TWO_R2\n');
    const otherFile = [...shell.files.values()].find((f) => f.relativePath === 'papers/other.md')!.fileId;
    const onB = structuredClone(onA);
    onB[0].data.resourceRef = { ...onB[0].data.resourceRef!, fileId: otherFile };
    onB[0].data.resourceHint = { ...onB[0].data.resourceHint!, name: 'other.md', relativePath: 'papers/other.md', revision: fakeRevision('FILE_TWO_R2\n') };
    onB[0].data.attachments = [{ ...onB[0].data.attachments[0], name: 'other.md', content: 'FILE_TWO_R2\n' }];

    const slow = shell.holdNext('readBytes');
    const reading = refreshResourceNode(id);
    await expect.poll(() => calls('readBytes').length).toBe(2);
    switchTo('canvas-2', onB);
    slow.release();
    await reading;
    expect(copyOf(id)).toEqual(['FILE_TWO_R2\n']);
    expect(node(id).data.resourceHint!.revision).toBe(fakeRevision('FILE_TWO_R2\n'));
  });

  it('does not put an old read over a newer copy after going to another canvas and back', async () => {
    two();
    const id = await place(shell.seed('notes/a.md', 'OLD_READ_R1\n'));
    const fileId = node(id).data.resourceRef!.fileId;
    // a read is under way and will answer with what the file held when it was asked
    const slow = shell.delayNext('readBytes');
    const reading = refreshResourceNode(id);
    await expect.poll(() => calls('readBytes').length).toBe(2);
    // meanwhile: away to another canvas, the file changes, and back, where the canvas already holds the newer copy
    const newer = structuredClone(useStore.getState().nodes);
    newer[0].data.attachments = [{ ...newer[0].data.attachments[0], content: 'NEWER_COPY_R2\n' }];
    newer[0].data.resourceHint = { ...newer[0].data.resourceHint!, revision: fakeRevision('NEWER_COPY_R2\n') };
    switchTo('canvas-2', []);
    shell.files.get(fileId)!.content = 'NEWER_COPY_R2\n';
    switchTo('canvas-1', newer);
    slow.release();
    await reading;
    expect(copyOf(id)).toEqual(['NEWER_COPY_R2\n']);
    expect(node(id).data.resourceHint!.revision).toBe(fakeRevision('NEWER_COPY_R2\n'));
  });
});
