import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import RunPreview from '../../src/components/workspace/RunPreview';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { inputBudgetFor } from '../../src/lib/context/budget';
import { prepareRun, RunBlocked } from '../../src/lib/context/prepare-run';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { during, mount, type Mounted } from '../helpers/render';

// How much a run may be given. A model whose window is known is held to it, less what
// its answer needs; for one that is not known, the person says, and until they do
// nothing is claimed and nothing is stopped. Over it, a run is not sent, is not cut,
// and says what is taking the room. On stand-ins for the shell and the model server.

const WINDOWED = 'synthetic-provider/windowed';
const UNKNOWN = 'synthetic-provider/unknown';
const CODEX = 'codex/gpt-synthetic';
const model = (id: string, more = {}) => ({ id, name: id, provider: id.startsWith('codex/') ? '__agent__' : 'synthetic-provider', vision: false, ...more });
const MODELS = () => ({ models: [model(WINDOWED, { contextLength: 20_000 }), model(UNKNOWN), model(CODEX)], default: null });
let desktop: FakeDesktop;
let posted: unknown[] = [];
let mounted: Mounted | null = null;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const words = (n: number) => 'word '.repeat(n);
function task(modelId: string, question: string, attachments: { name: string; text: string }[] = []) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 300 * useStore.getState().nodes.length });
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, attachments: attachments.map((a, i) => ({ id: `a${i}`, name: a.name, type: 'text/plain', content: a.text, extractedText: a.text })) } } : n)) }) as never);
  return id;
}
const prepare = (id: string) => prepareRun({ graphId: 'c', targetNodeId: id, question: node(id).data.question, mode: 'workspace', runtimeSelection: { kind: 'provider', runtime: null, connectionRef: 'x', model: node(id).data.target!.model, effort: null, capabilityVersion: null } });

beforeAll(() => bootProjects());
beforeEach(async () => {
  posted = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) { posted.push(JSON.parse(String(init?.body))); return new Response('data: {"text":"ok"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); }
    return Response.json({});
  });
  desktop = installFakeDesktop();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'c', name: 'c', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: 'c', switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false });
  useUiStore.getState().setInputBudget(null);
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
  useUiStore.getState().setSelectedModel(WINDOWED);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  desktop.uninstall();
  vi.unstubAllGlobals();
  useUiStore.getState().setInputBudget(null);
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

describe('[budget] where the limit comes from', () => {
  it('[budget] a window known: the window, less what the answer needs', () => {
    expect(inputBudgetFor(WINDOWED)).toEqual({ maxInputTokens: 20_000 - 8_192, inputLimitFrom: 'model-window' });
  });
  it('[budget] not known, and nothing said: no limit, and it says so', () => {
    expect(inputBudgetFor(UNKNOWN)).toEqual({ maxInputTokens: 0, inputLimitFrom: 'unset' });
    expect(inputBudgetFor(CODEX)).toEqual({ maxInputTokens: 0, inputLimitFrom: 'unset' });
  });
  it('[budget] not known, and the person says: what they said', () => {
    useUiStore.getState().setInputBudget(50_000);
    expect(inputBudgetFor(UNKNOWN)).toEqual({ maxInputTokens: 50_000, inputLimitFrom: 'person' });
    expect(inputBudgetFor(WINDOWED).inputLimitFrom).toBe('model-window');
  });
  it('[budget] a window too small to leave room for an answer is still a limit, not none', () => {
    setModelsCache({ models: [model(WINDOWED, { contextLength: 4_000 })], default: null } as never);
    expect(inputBudgetFor(WINDOWED).maxInputTokens).toBe(1);
  });
  it('[budget] what is said is kept for the next launch, and nonsense is no limit', () => {
    useUiStore.getState().setInputBudget(70_000);
    expect(localStorage.getItem('thoughtdag.inputBudget')).toBe('70000');
    useUiStore.getState().setInputBudget(-3);
    expect(useUiStore.getState().inputBudget).toBeNull();
    expect(localStorage.getItem('thoughtdag.inputBudget')).toBeNull();
  });
});

describe('[budget] a run over it', () => {
  it('[budget] is not prepared, is not cut, and names what takes the room', async () => {
    const id = task(WINDOWED, 'Big?', [{ name: 'huge-one.txt', text: words(40_000) }, { name: 'small.txt', text: 'tiny' }]);
    const refused = await prepare(id).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RunBlocked);
    expect((refused as RunBlocked).reason).toBe('over-budget');
    expect((refused as RunBlocked).message).toMatch(/huge-one\.txt/);
    expect((refused as RunBlocked).message).toMatch(/11[,]?808/);
  });
  it('[budget] through the run path: nothing is sent, and the task says why', async () => {
    const id = task(WINDOWED, 'Big?', [{ name: 'huge-one.txt', text: words(40_000) }]);
    await useStore.getState().rerunNode(id, {});
    expect(posted).toEqual([]);
    expect(node(id).data.response).toMatch(/huge-one\.txt/);
  });
  it('[budget] an agent with a limit the person set is held to it, and is not started', async () => {
    useUiStore.getState().setInputBudget(1_000);
    useUiStore.getState().setSelectedModel(CODEX);
    const id = task(CODEX, 'Big?', [{ name: 'huge-one.txt', text: words(40_000) }]);
    await useStore.getState().rerunNode(id, {});
    expect(desktop.runs).toEqual([]);
  });
  it('[budget] under it, a run goes, and its limit and where it came from are in what it was given', async () => {
    const id = task(WINDOWED, 'Small?');
    const envelope = await prepare(id);
    expect(envelope.policy.budget).toMatchObject({ maxInputTokens: 11_808, inputLimitFrom: 'model-window' });
    await useStore.getState().rerunNode(id, {});
    expect(posted).toHaveLength(1);
  });
  it('[budget] no limit known: however much it is given, it goes whole, as it always did', async () => {
    useUiStore.getState().setSelectedModel(UNKNOWN);
    const id = task(UNKNOWN, 'Big?', [{ name: 'huge-one.txt', text: words(400_000) }]);
    const envelope = await prepare(id);
    expect(envelope.policy.budget).toMatchObject({ maxInputTokens: 0, inputLimitFrom: 'unset' });
    expect(JSON.stringify(envelope.messages).length).toBeGreaterThan(words(400_000).length);
  });
});

describe('[budget] on the task\'s panel', () => {
  const panel = async (id: string) => { mounted = await mount(<RunPreview nodeId={id} />); return mounted.container; };
  it('[budget] a known window is said, and there is nothing to set', async () => {
    const root = await panel(task(WINDOWED, 'Q?'));
    expect(root.querySelector('[data-input-limit]')?.getAttribute('data-input-limit')).toBe('model-window');
    expect(root.querySelector('[data-input-limit]')?.textContent).toMatch(/11[,]?808/);
    expect(root.querySelector('[data-input-budget-field]')).toBeNull();
  });
  it('[budget] an unknown window says so, and what is typed is the limit for every model not known', async () => {
    useUiStore.getState().setSelectedModel(UNKNOWN);
    const root = await panel(task(UNKNOWN, 'Q?'));
    expect(root.querySelector('[data-input-limit]')?.getAttribute('data-input-limit')).toBe('unset');
    const field = root.querySelector('[data-input-budget-field]') as HTMLInputElement;
    await during(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '60000');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(useUiStore.getState().inputBudget).toBe(60_000);
    expect(root.querySelector('[data-input-limit]')?.getAttribute('data-input-limit')).toBe('person');
  });
});
