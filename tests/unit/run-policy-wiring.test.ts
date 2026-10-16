import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, connectRefs, newTask, setRunMode, templateFor } from '../../src/lib/agents/targets';
import { documents } from '../../src/lib/documents/document-service';
import { emptyDoc } from '../../src/lib/profile';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// What a run is held to, as the app makes runs. A task set to research is
// given its inputs and its question and nothing else: through an API that
// is what is sent (no memory, no web search, nothing left out); on an agent
// it is not sent while the agent is not known to keep to that. A task at
// work on an agent is given its inputs on disk from the run's envelope, and
// a run whose inputs the shell will not write is not sent.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
let shell: FakeWorkspace;
let desktop: FakeDesktop;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const model = (id: string, more: Record<string, unknown> = {}) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false, ...more });
const MODELS = () => ({ models: [model(CODEX, { efforts: ['low', 'medium', 'high'] }), model(API_MODEL)], default: null });

function task(modelId: string, question: string, ...materials: string[]) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 });
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, response: 'an earlier answer', responses: ['an earlier answer'], responseIndex: 0 } } : n)),
    edges: [...st.edges, ...materials.map((m) => ({ id: `edge-${m}-${id}`, source: m, target: id }))],
  }));
  return id;
}
/** Leave a material node's copy out of a task, as the person does from the task's panel. */
function leaveOut(taskId: string, materialId: string) {
  const attachmentId = node(materialId).data.attachments[0].id;
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === taskId ? { ...n, data: { ...n.data, excludedAttachmentIds: [...n.data.excludedAttachmentIds, attachmentId] } } : n)) }));
}
type Body = { messages: { role: string; content: string }[]; webSearch?: boolean; scholarSearch?: boolean; mcpTools?: boolean };
function captureApi(): Body[] {
  desktop.uninstall();
  const bodies: Body[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(`data: ${JSON.stringify({ text: 'AN_ANSWER' })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
  return bodies;
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: true, webSearchEnabled: true, recallEnabled: false, profile: { identity: { ...emptyDoc(), text: 'MEMORY_MARKER_M3' }, preferences: emptyDoc() } });
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
  useUiStore.setState({ memoryEnabled: false, webSearchEnabled: false, profile: { identity: emptyDoc(), preferences: emptyDoc() } });
  useUiStore.getState().setSelectedModel(null);
});

describe('a task set to research', () => {
  it('[T12] through an API is sent its inputs and its question only: nothing left out, nothing unwired, no memory, no web search', async () => {
    const bodies = captureApi();
    const keep = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/keep.md', 'KEEP_THIS_A1\n'), { x: 0, y: 0 });
    const secret = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/secret.md', 'EXCLUDED_SECRET_K7\n'), { x: 300, y: 0 });
    shell.seed('notes/unwired.md', 'UNWIRED_SECRET_Q9\n');
    const t = task(API_MODEL, 'What does it say?', keep, secret);
    leaveOut(t, secret);
    setRunMode(t, 'research');
    await useStore.getState().rerunNode(t);
    expect(bodies.length).toBe(1);
    const sent = bodies[0].messages.map((m) => m.content).join('\n');
    expect(sent).toContain('KEEP_THIS_A1');
    for (const marker of ['EXCLUDED_SECRET_K7', 'UNWIRED_SECRET_Q9', 'MEMORY_MARKER_M3']) expect(sent).not.toContain(marker);
    expect(bodies[0].webSearch).toBeFalsy();
    expect(node(t).data.response).toBe('AN_ANSWER');
    expect(node(t).data.lastRun).toBeDefined();
  });

  it('[T12] the same task at work is given memory and web search as set: the research run left them out', async () => {
    const bodies = captureApi();
    const keep = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/keep.md', 'KEEP_THIS_A1\n'), { x: 0, y: 0 });
    const t = task(API_MODEL, 'What does it say?', keep);
    await useStore.getState().rerunNode(t);
    expect(bodies.length).toBe(1);
    expect(bodies[0].messages.map((m) => m.content).join('\n')).toContain('MEMORY_MARKER_M3');
    expect(bodies[0].webSearch).toBe(true);
  });

  it('[T12] on an agent is not sent while the agent is not known to keep to its inputs, offline and without its own memory', async () => {
    const keep = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/keep.md', 'KEEP_THIS_A1\n'), { x: 0, y: 0 });
    const t = task(CODEX, 'What does it say?', keep);
    setRunMode(t, 'research');
    await useStore.getState().rerunNode(t);
    for (let i = 0; i < 5; i++) await settled();
    expect(desktop.runs).toEqual([]);
    expect(desktop.materials).toEqual([]);
    expect(node(t).data.responses).toEqual(['an earlier answer']);
    expect(node(t).data.isLoading).toBe(false);
    expect(node(t).data.lastRun).toBeUndefined();
    expect(node(t).data.generationFailed).toBe(true);
  });

  it('[T12] is a target of its own: the task it shared a target with stays at work, and a question asked below it is researched too', async () => {
    const shared = createTarget(templateFor(API_MODEL));
    const a = newTask(shared, { x: 0, y: 0 });
    const b = newTask(shared, { x: 400, y: 0 });
    const made = setRunMode(a, 'research');
    expect(made.targetId).not.toBe(shared.targetId);
    expect(made.revision).not.toBe(shared.revision);
    expect(node(a).data.target!.policyId).toBe('research');
    expect(node(b).data.target!.targetId).toBe(shared.targetId);
    expect(setRunMode(a, 'research')).toBe(made);
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === a ? { ...n, data: { ...n.data, question: 'first', response: 'done', responses: ['done'], responseIndex: 0 } } : n)) }));
    captureApi();
    await useStore.getState().addQuestion('and then?', { parentId: a });
    const below = useStore.getState().nodes.find((n) => n.data.question === 'and then?')!;
    expect(below.data.target!.policyId).toBe('research');
  });
});

describe('an agent at work', () => {
  it('[T12] is given its inputs on disk from the run\'s envelope: a passage as the passage, two files of one name as two, nothing left out, and the prompt says where', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('a/notes.md', 'FROM_A\n'), { x: 0, y: 0 });
    const b = await attachEntry(CANVAS, 'ws_1', shell.seed('b/notes.md', 'FROM_B\n'), { x: 300, y: 0 });
    const secret = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/secret.md', 'EXCLUDED_SECRET_K7\n'), { x: 600, y: 0 });
    shell.seed('paper.md', 'WHOLE_FILE_INTRO\nThe method uses a trimmed mean here.\nWHOLE_FILE_OUTRO\n');
    const t = task(CODEX, 'What does it say?', a, b, secret);
    leaveOut(t, secret);
    const [wired] = await connectRefs(t, [{ fileId: fileIdOf('paper.md'), selector: { kind: 'text', quote: 'trimmed mean', prefix: 'uses a ', suffix: ' here' }, version: { kind: 'live' }, payload: 'text' }]);
    expect(wired.ok).toBe(true);
    await useStore.getState().rerunNode(t);
    expect(desktop.runs.length).toBe(1);
    const written = desktop.materials.at(-1)!;
    const run = node(t).data.lastRun!;
    expect(written.runId).toBe(run.runId);
    const contents = written.files.map((f) => f.content);
    expect(contents).toEqual(expect.arrayContaining(['FROM_A\n', 'FROM_B\n', 'trimmed mean']));
    expect(contents.join('\n')).not.toContain('EXCLUDED_SECRET_K7');
    expect(contents.join('\n')).not.toContain('WHOLE_FILE_INTRO');
    const names = written.files.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n.endsWith('notes.md')).length).toBe(2);
    // one file per input of the run, and the prompt names each
    expect(written.files.length).toBe(run.inputs.length);
    const prompt = desktop.runs[0].prompt;
    expect(prompt).toContain(`.thoughtdag/runs/${run.runId}`);
    for (const n of names) expect(prompt).toContain(n);
    expect(prompt).not.toContain('EXCLUDED_SECRET_K7');
  });

  it('[T12] is not sent when the shell will not write its inputs as they were frozen, and says why', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A\n'), { x: 0, y: 0 });
    const t = task(CODEX, 'What does it say?', m);
    window.desktopAgents!.materialize = async () => ({ ok: false, code: 'too-large', message: 'the inputs of the run come to more than 64 MiB', inputId: null });
    await useStore.getState().rerunNode(t);
    for (let i = 0; i < 5; i++) await settled();
    expect(desktop.runs).toEqual([]);
    expect(node(t).data.responses).toEqual(['an earlier answer']);
    expect(node(t).data.lastRun).toBeUndefined();
    expect(node(t).data.generationFailed).toBe(true);
    expect(useUiStore.getState().toasts.map((toast) => toast.kind)).toContain('error');
  });
});
