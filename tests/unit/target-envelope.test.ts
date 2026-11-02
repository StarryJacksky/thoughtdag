import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, newTask, retarget, setRunMode, templateFor } from '../../src/lib/agents/targets';
import { kindOf, setTargetSettings } from '../../src/lib/agents/target-model';
import { noteCapabilities } from '../../src/lib/context/policy';
import { prepareTargetRun } from '../../src/lib/context/prepare-target-run';
import { RunBlocked } from '../../src/lib/context/prepare-run';
import { documents } from '../../src/lib/documents/document-service';
import { emptyDoc } from '../../src/lib/profile';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ExecutionTarget } from '../../src/lib/context/contracts';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// What a task's target holds, and what a run of it comes to (T27): a target says what
// it runs under, the run is prepared from it, and what is on the toolbar afterwards
// changes no target. Two tasks on one canvas are given each its own. On stand-ins for
// the desktop shell and the workspace.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
const MEMORY = 'MEMORY_MARKER_M3';
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: true, tools: true, webSearch: true, scholarSearch: true });
const MODELS = () => ({ models: [model(CODEX), model(API_MODEL)], default: null });
let shell: FakeWorkspace;
let desktop: FakeDesktop;
let bodies: { messages: { content: string }[]; webSearch?: boolean; scholarSearch?: boolean; mcpTools?: boolean; model?: string }[] = [];
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const ui = () => useUiStore.getState();

function task(modelId: string, question: string, ...materials: string[]) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 + 100 * useStore.getState().nodes.length });
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, response: 'an earlier answer', responses: ['an earlier answer'] } } : n)),
    edges: [...st.edges, ...materials.map((m) => ({ id: `edge-${m}-${id}`, source: m, target: id }))],
  }));
  return id;
}
const revisionOf = (id: string) => node(id).data.target!.revision;
const prepared = (id: string) => prepareTargetRun(CANVAS, id, revisionOf(id));

beforeAll(() => bootProjects());
beforeEach(async () => {
  bodies = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(`data: ${JSON.stringify({ text: 'AN_ANSWER' })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({});
  });
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false, webSearchEnabled: false, scholarSearchEnabled: false, mcpEnabled: false, profile: { identity: { ...emptyDoc(), text: MEMORY }, preferences: emptyDoc() } });
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
  ui().setSelectedModel(API_MODEL);
});
afterEach(async () => {
  await documents.dispose();
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  noteCapabilities('codex', null);
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.setState({ memoryEnabled: false, webSearchEnabled: false, profile: { identity: emptyDoc(), preferences: emptyDoc() } });
  ui().setSelectedModel(null);
});

describe('[T27] what a target holds', () => {
  it('[T27] a new target is made with what is set now, and what is set later changes no target', () => {
    useUiStore.setState({ memoryEnabled: true, webSearchEnabled: true, scholarSearchEnabled: true, mcpEnabled: true, recallEnabled: true });
    const made = createTarget(templateFor(API_MODEL));
    expect(made.memoryPolicyId).toBe('memory:on');
    expect(made.tools).toEqual({ web: true, scholar: true, mcp: true, recall: true });
    const copy = structuredClone(made);
    useUiStore.setState({ memoryEnabled: false, webSearchEnabled: false, scholarSearchEnabled: false, mcpEnabled: false, recallEnabled: false });
    expect(made).toEqual(copy);
    const later = createTarget(templateFor(API_MODEL));
    expect(later.memoryPolicyId).toBe('memory:off');
    expect(later.tools).toEqual({ web: false, scholar: false, mcp: false, recall: false });
  });

  const changes: [string, Partial<ExecutionTarget>][] = [
    ['role', { roleRef: 'role:reviewer' }],
    ['memory', { memoryPolicyId: 'memory:on' }],
    ['model', { model: 'synthetic-provider/other' }],
    ['effort', { effort: 'high' }],
    ['tools', { tools: { web: true, scholar: false, mcp: false, recall: false } }],
    ['connection', { connectionRef: 'provider:other' }],
  ];
  for (const [what, patch] of changes) {
    it(`[T27] changing its ${what} changes its revision, and it is a target of its own`, () => {
      const was = createTarget(templateFor(API_MODEL));
      const now = setTargetSettings(was, patch);
      expect(now.revision).not.toBe(was.revision);
      expect(now.targetId).not.toBe(was.targetId);
      expect(setTargetSettings(now, patch)).toBe(now);
    });
  }

  it('[T27] giving a task a role changes its target; the task it shared a target with keeps its own', () => {
    const shared = createTarget(templateFor(API_MODEL));
    const a = newTask(shared, { x: 0, y: 0 });
    const b = newTask(shared, { x: 0, y: 200 });
    useStore.getState().setRolePrompt(a, 'You review methods.');
    expect(node(a).data.target!.roleRef).toMatch(/^role:/);
    expect(node(a).data.target!.revision).not.toBe(shared.revision);
    expect(node(b).data.target).toEqual(shared);
    const withRole = node(a).data.target!;
    useStore.getState().setRolePrompt(a, 'You review methods.');
    expect(node(a).data.target).toEqual(withRole);
    useStore.getState().setRolePrompt(a, '');
    expect(node(a).data.target!.roleRef).toBeNull();
  });

  it('[T27] another AI for a task keeps what else it runs under', () => {
    useUiStore.setState({ memoryEnabled: true, webSearchEnabled: true });
    const id = newTask(createTarget(templateFor(API_MODEL)), { x: 0, y: 0 });
    useUiStore.setState({ memoryEnabled: false, webSearchEnabled: false });
    const now = retarget(id, { model: CODEX });
    expect(now.memoryPolicyId).toBe('memory:on');
    expect(now.tools?.web).toBe(true);
    expect(kindOf(now)).toBe('agent');
  });

  it('[T27] a target made before these were held says nothing of them, and is still a target', () => {
    const { tools, ...old } = createTarget(templateFor(API_MODEL));
    void tools;
    expect(setTargetSettings({ ...old, memoryPolicyId: 'default' }, {}).memoryPolicyId).toBe('default');
  });
});

describe('[T27] a run is prepared from its target', () => {
  it('[T27] two tasks are each given their own: nothing of the other\'s comes along', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A_ONLY_K7\n'), { x: 0, y: 0 });
    const b = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/b.md', 'B_ONLY_Q9\n'), { x: 300, y: 0 });
    const x = task(CODEX, 'What does X have?', a);
    const y = task(API_MODEL, 'What does Y have?', b);
    const [px, py] = [await prepared(x), await prepared(y)];
    const text = (e: typeof px) => JSON.stringify([e.envelope.messages, e.envelope.inputs]);
    expect(text(px)).toContain('A_ONLY_K7');
    expect(text(px)).not.toContain('B_ONLY_Q9');
    expect(text(py)).toContain('B_ONLY_Q9');
    expect(text(py)).not.toContain('A_ONLY_K7');
    expect(px.target.targetId).toBe(node(x).data.target!.targetId);
    expect(px.envelope.targetId).toBe(px.target.targetId);
    expect(px.envelope.targetRevision).toBe(px.target.revision);
    expect(px.envelope.runtime.kind).toBe('agent');
    expect(py.envelope.runtime.kind).toBe('provider');
    expect(px.envelope.runId).not.toBe(py.envelope.runId);
  });

  it('[T27] what the shell is given for each run is only that run\'s, through the real run path', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A_ONLY_K7\n'), { x: 0, y: 0 });
    const b = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/b.md', 'B_ONLY_Q9\n'), { x: 300, y: 0 });
    const x = task(CODEX, 'What does X have?', a);
    const y = task(CODEX, 'What does Y have?', b);
    await Promise.all([useStore.getState().rerunNode(x, {}), useStore.getState().rerunNode(y, {})]);
    expect(desktop.materials).toHaveLength(2);
    const contents = desktop.materials.map((m) => m.files.map((f) => f.content).join());
    expect(contents.filter((c) => c.includes('A_ONLY_K7') && !c.includes('B_ONLY_Q9'))).toHaveLength(1);
    expect(contents.filter((c) => c.includes('B_ONLY_Q9') && !c.includes('A_ONLY_K7'))).toHaveLength(1);
    expect(new Set(desktop.materials.map((m) => m.runId)).size).toBe(2);
    for (const run of desktop.runs) expect(run.prompt.includes('A_ONLY_K7') && run.prompt.includes('B_ONLY_Q9')).toBe(false);
  });

  it('[T27] two images of one length and other contents are two inputs', async () => {
    const image = (content: string) => [{ id: `att-${content}`, name: 'p.png', type: 'image/png', content, size: content.length }];
    const x = task(API_MODEL, 'Look?');
    const y = task(API_MODEL, 'Look?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, attachments: image('AQIDBA==') } } : n.id === y ? { ...n, data: { ...n.data, attachments: image('BQYHCA==') } } : n)) }));
    const [px, py] = [await prepared(x), await prepared(y)];
    expect(px.envelope.inputDigest).not.toBe(py.envelope.inputDigest);
  });

  it('[T27] a target that has changed since the run was planned is not prepared', async () => {
    const id = task(API_MODEL, 'Plan?');
    const planned = revisionOf(id);
    retarget(id, { model: CODEX });
    await expect(prepareTargetRun(CANVAS, id, planned)).rejects.toMatchObject({ reason: 'target-changed', nodeId: id });
  });

  it('[T27] a node with no target is not prepared: there is no AI to freeze', async () => {
    const id = task(API_MODEL, 'Plan?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, target: undefined } } : n)) }));
    await expect(prepareTargetRun(CANVAS, id, 'rev_x')).rejects.toBeInstanceOf(RunBlocked);
  });

  it('[T27] a source that can no longer be read stops the run from being prepared, and nothing is sent', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A_ONLY_K7\n'), { x: 0, y: 0 });
    const id = task(CODEX, 'Read it?', a);
    shell.failNext('freezeFile', 'access-denied', 'that folder is no longer allowed');
    await expect(prepared(id)).rejects.toBeInstanceOf(RunBlocked);
    shell.calm();
    shell.failNext('freezeFile', 'access-denied', 'that folder is no longer allowed');
    await useStore.getState().rerunNode(id, {});
    expect(desktop.runs).toEqual([]);
    expect(node(id).data.response).toBeTruthy();
  });

  it('[T27] research is prepared as research, with the tools and memory left out, whatever the target holds', async () => {
    useUiStore.setState({ memoryEnabled: true, webSearchEnabled: true });
    const id = task(API_MODEL, 'Research?');
    setRunMode(id, 'research');
    const { envelope } = await prepared(id);
    expect(envelope.mode).toBe('research');
    expect(envelope.policy.tools?.allow).toEqual([]);
    expect(envelope.policy.recall).toBe('off');
    expect(JSON.stringify(envelope.messages)).not.toContain(MEMORY);
  });
});

describe('[T27] a run goes by its target, not by what is set now', () => {
  it('[T27] memory on when the task was made, off now: the run has its memory', async () => {
    useUiStore.setState({ memoryEnabled: true });
    const id = task(API_MODEL, 'Who am I?');
    useUiStore.setState({ memoryEnabled: false });
    await useStore.getState().rerunNode(id, {});
    expect(JSON.stringify(bodies[0].messages)).toContain(MEMORY);
  });

  it('[T27] memory off when the task was made, on now: the run has none', async () => {
    const id = task(API_MODEL, 'Who am I?');
    useUiStore.setState({ memoryEnabled: true });
    await useStore.getState().rerunNode(id, {});
    expect(JSON.stringify(bodies[0].messages)).not.toContain(MEMORY);
  });

  it('[T27] the tools it was made with travel, whatever is set now', async () => {
    useUiStore.setState({ webSearchEnabled: true, mcpEnabled: true });
    const id = task(API_MODEL, 'Search?');
    useUiStore.setState({ webSearchEnabled: false, mcpEnabled: false });
    await useStore.getState().rerunNode(id, {});
    expect(bodies[0].webSearch).toBe(true);
    expect(bodies[0].mcpTools).toBe(true);
  });

  it('[T27] tools off when the task was made, on now: they do not come', async () => {
    const id = task(API_MODEL, 'Search?');
    useUiStore.setState({ webSearchEnabled: true, scholarSearchEnabled: true, mcpEnabled: true });
    await useStore.getState().rerunNode(id, {});
    expect(bodies[0].webSearch).toBeFalsy();
    expect(bodies[0].scholarSearch).toBeFalsy();
    expect(bodies[0].mcpTools).toBeFalsy();
  });

  it('[T27] what the task itself was set to ask still comes first: its own search switch', async () => {
    const id = task(API_MODEL, 'Search?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, webSearch: true } } : n)) }));
    await useStore.getState().rerunNode(id, {});
    expect(bodies[0].webSearch).toBe(true);
  });

  it('[T27] a target from before follows what is set now, as it always did: nothing of an old canvas changes', async () => {
    const id = task(API_MODEL, 'Old?');
    const { tools, ...old } = node(id).data.target!;
    void tools;
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, target: { ...old, memoryPolicyId: 'default' } } } : n)) }));
    useUiStore.setState({ memoryEnabled: true, webSearchEnabled: true });
    await useStore.getState().rerunNode(id, {});
    expect(JSON.stringify(bodies[0].messages)).toContain(MEMORY);
    expect(bodies[0].webSearch).toBe(true);
  });
});
