import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import StaleSection from '../../src/components/workspace/StaleSection';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { documents } from '../../src/lib/documents/document-service';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { subscribeWorkspace } from '../../src/lib/workspace/events';
import { applyWorkspaceEvent, attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, type Mounted } from '../helpers/render';

// On a task's panel: whether its answer is out of date and why, what can be
// done about it, and the files the version shown read.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
let shell: FakeWorkspace;
let desktop: FakeDesktop;
let view: Mounted | null = null;
let stop: (() => void) | null = null;
let answers = 0;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false });
const MODELS = () => ({ models: [model(CODEX), model(API_MODEL)], default: null });
const q = (selector: string) => view!.container.querySelector<HTMLElement>(selector);

function task(modelId: string, question: string, ...from: string[]) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 + 200 * useStore.getState().nodes.length });
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question } } : n)),
    edges: [...st.edges, ...from.map((m) => ({ id: `edge-${m}-${id}`, source: m, target: id }))],
  }));
  return id;
}
/** A task that read a file, answered, and whose file then changed. */
async function outOfDate(modelId: string) {
  const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A1\n'), { x: 0, y: 0 });
  const t = task(modelId, 'about a', a);
  await useStore.getState().rerunNode(t);
  shell.editExternally(fileIdOf('notes/a.md'), 'A2\n');
  await vi.waitFor(() => expect(node(a).data.attachments[0].content).toBe('A2\n'));
  useStore.getState().recomputeStaleness();
  return t;
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  answers = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) return new Response(`data: ${JSON.stringify({ text: `ANSWER_${++answers}` })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error(`Unexpected network request: ${url}`);
  });
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {}, staleReasons: {} });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false });
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
  stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  stop?.();
  await documents.dispose();
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {}, staleReasons: {} });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

describe('an answer out of date, on its panel', () => {
  it('[T13] says which file changed, runs it again on request beside the old answer, and is no longer out of date', async () => {
    const t = await outOfDate(API_MODEL);
    view = await mount(<StaleSection nodeId={t} />);
    expect(q('[data-stale-reason="input-changed"]')!.textContent).toContain('a.md');
    expect(q('[data-replay="keep"]')).not.toBeNull();
    await during(async () => { q('[data-replay="target-only"]')!.click(); await vi.waitFor(() => expect(node(t).data.responses.length).toBe(2)); });
    expect(node(t).data.responses).toEqual(['ANSWER_1', 'ANSWER_2']);
    await during(() => useStore.getState().recomputeStaleness());
    expect(q('[data-stale-reasons]')).toBeNull();
  });

  it('[T13] keeps the old answer when asked to, and says nothing more about it', async () => {
    const t = await outOfDate(API_MODEL);
    view = await mount(<StaleSection nodeId={t} />);
    await during(async () => { q('[data-replay="keep"]')!.click(); await new Promise((r) => setTimeout(r, 10)); });
    expect(q('[data-stale-reasons]')).toBeNull();
    expect(node(t).data.responses).toEqual(['ANSWER_1']);
  });

  it('[T13] offers nothing to run for an agent that may write files: it says the person runs it', async () => {
    const t = await outOfDate(CODEX);
    view = await mount(<StaleSection nodeId={t} />);
    expect(q('[data-stale-reasons]')).not.toBeNull();
    expect(q('[data-stale-waits]')).not.toBeNull();
    expect(q('[data-replay]')).toBeNull();
  });

  it('[T13] names the files the version shown read, as they were frozen then', async () => {
    const t = await outOfDate(API_MODEL);
    view = await mount(<StaleSection nodeId={t} />);
    expect(q('[data-version-inputs]')!.textContent).toContain('a.md');
  });
});
