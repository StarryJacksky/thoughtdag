import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareRun } from '../../src/lib/context/prepare-run';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { documents } from '../../src/lib/documents/document-service';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { fakeRevision, installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// Runs as the app makes them, frozen first: each way a run starts saves and
// freezes the files it reads before its context is built, the request that
// leaves is the envelope prepared for it, the answer says which run it came
// from, and a run whose files cannot be given as they are is not sent.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
let shell: FakeWorkspace;
let desktop: FakeDesktop;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const calls = () => shell.calls.map((c) => c.method);
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const model = (id: string, more: Record<string, unknown> = {}) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false, ...more });
const MODELS = () => ({ models: [model(CODEX, { efforts: ['low', 'medium', 'high'] }), model(API_MODEL)], default: null });

function task(modelId: string, question: string, answer: string, ...materials: string[]) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 });
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, response: answer, responses: [answer], responseIndex: 0 } } : n)),
    edges: [...st.edges, ...materials.map((m) => ({ id: `edge-${m}-${id}`, source: m, target: id }))],
  }));
  return id;
}
const everythingSent = () => desktop.runs.map((r) => r.prompt).concat(desktop.readableFileContents()).join('\n');

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [] });
  useUiStore.getState().setSelectedModel(CODEX);
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
});
afterEach(async () => {
  await documents.dispose();
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

describe('a run, frozen before it is sent', () => {
  it('[T11] saves what is typed into a file the task reads, freezes it, sends that, and the answer names the run it came from', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'SAVED_BEFORE\n'), { x: 0, y: 0 });
    const t = task(CODEX, 'What does it say?', 'an earlier answer', m);
    const doc = await documents.open(fileIdOf('notes/a.md'), 'view-1');
    documents.setText(doc.documentId, 'TYPED_AND_NOT_SAVED_YET\n', 'view-1');
    await useStore.getState().rerunNode(t);
    const order = calls().filter((c) => c === 'saveText' || c === 'freezeFile');
    expect(order.slice(0, 2)).toEqual(['saveText', 'freezeFile']);
    expect(everythingSent()).toContain('TYPED_AND_NOT_SAVED_YET');
    expect(everythingSent()).not.toContain('SAVED_BEFORE');
    const run = node(t).data.lastRun!;
    expect(run.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.executionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(run.inputs).toEqual([expect.objectContaining({ contentHash: fakeRevision('TYPED_AND_NOT_SAVED_YET\n'), snapshotId: expect.stringMatching(/^snap_/) })]);
    // what was sent is what preparing the same task again gives: the digest is of what went out
    expect((await prepareRun({ graphId: CANVAS, targetNodeId: t, question: 'What does it say?', mode: 'workspace', runtimeSelection: { kind: 'agent', runtime: 'codex', connectionRef: node(t).data.target!.connectionRef, model: CODEX, effort: node(t).data.target!.effort, capabilityVersion: null } })).inputDigest).toBe(run.inputDigest);
  });

  it('[T11] is not sent when a file it reads is lost: the task says why, and no answer is recorded', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task(CODEX, 'What does it say?', 'an earlier answer', m);
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'missing';
    await useStore.getState().rerunNode(t);
    for (let i = 0; i < 5; i++) await settled();
    expect(desktop.runs).toEqual([]);
    expect(node(t).data.responses).toEqual(['an earlier answer']);
    expect(node(t).data.isLoading).toBe(false);
    expect(node(t).data.lastRun).toBeUndefined();
    expect(node(t).data.response).toContain('a.md');
    expect(useUiStore.getState().toasts.map((toast) => toast.kind)).toContain('error');
  });

  it('[T11] is not sent, asked below a task, when the file it reads is in conflict with what is typed into it', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task(CODEX, 'What does it say?', 'an earlier answer', m);
    const fileId = fileIdOf('notes/a.md');
    const doc = await documents.open(fileId, 'view-1');
    documents.setText(doc.documentId, 'MINE\n', 'view-1');
    shell.files.get(fileId)!.content = 'THEIRS\n';
    documents.noteWorkspaceEvent({ workspaceId: 'ws_1', fileId, change: 'content', observedRevision: fakeRevision('THEIRS\n'), opId: null, record: shell.record(fileId) });
    await vi.waitFor(() => expect(documents.get(doc.documentId)!.state).toBe('conflict'));
    await useStore.getState().addQuestion('FOLLOW_UP: and then?', { parentId: t });
    for (let i = 0; i < 5; i++) await settled();
    expect(desktop.runs).toEqual([]);
    const asked = useStore.getState().nodes.find((n) => n.data.question === 'FOLLOW_UP: and then?')!;
    expect(asked.data.isLoading).toBe(false);
    expect(asked.data.responses).toEqual([]);
    expect(asked.data.response).toContain('a.md');
  });

  it('[T11] to a model through its API sends exactly the envelope\'s messages', async () => {
    desktop.uninstall();
    const bodies: { messages: { role: string; content: string }[]; model?: string }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/models')) return Response.json(MODELS());
      if (url.endsWith('/api/stream')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response(`data: ${JSON.stringify({ text: 'AN_ANSWER' })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error(`Unexpected network request: ${url}`);
    });
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'FROZEN_FOR_THE_API\n'), { x: 0, y: 0 });
    const t = task(API_MODEL, 'What does it say?', 'an earlier answer', m);
    await useStore.getState().rerunNode(t);
    expect(bodies.length).toBe(1);
    expect(bodies[0].model).toBe(API_MODEL);
    const envelope = await prepareRun({ graphId: CANVAS, targetNodeId: t, question: 'What does it say?', mode: 'research', runtimeSelection: { kind: 'provider', runtime: null, connectionRef: node(t).data.target!.connectionRef, model: API_MODEL, effort: null, capabilityVersion: null } });
    expect(bodies[0].messages.map(({ role, content }) => ({ role, content }))).toEqual(envelope.messages.map(({ role, content }) => ({ role, content })));
    expect(node(t).data.lastRun!.inputDigest).toBe(envelope.inputDigest);
    expect(node(t).data.response).toBe('AN_ANSWER');
  });
});
