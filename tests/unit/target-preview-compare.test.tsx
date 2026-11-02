import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TargetPreviewCompare from '../../src/components/agents/TargetPreviewCompare';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { during, mount, type Mounted } from '../helpers/render';

// Comparing what two tasks would be given sends nothing, and each is sent by its own
// button. On a stand-in for the model server.

const MODELS = () => ({ models: ['p/one', 'p/two'].map((id) => ({ id, name: id, provider: 'p', vision: false })), default: null });
let posted: { model?: string }[] = [];
let mounted: Mounted | null = null;
const show = async (ids: string[]) => { mounted = await mount(<TargetPreviewCompare nodeIds={ids} onClose={() => {}} />); return mounted; };
function task(model: string, question: string, attachments: unknown[] = []) {
  const id = newTask(createTarget(templateFor(model)), { x: 0, y: 300 * useStore.getState().nodes.length });
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, attachments } } : n)) }) as never);
  return id;
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  posted = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) { posted.push(JSON.parse(String(init?.body))); return new Response('data: {"text":"ok"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); }
    return Response.json({});
  });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: 'c', name: 'c', createdAt: 0, updatedAt: 0 }], activeId: 'c', switching: false });
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
  useUiStore.getState().setSelectedModel('p/one');
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

describe('[T29] comparing before sending', () => {
  it('[T29] says what each would be given and what the other would not, and sends nothing', async () => {
    const x = task('p/one', 'First?', [{ id: 'a', name: 'only-first.txt', type: 'text/plain', content: 'ONLY', extractedText: 'ONLY' }]);
    const y = task('p/two', 'Second?');
    const { container } = await show([x, y]);
    await vi.waitFor(() => expect(container.querySelectorAll('[data-compare-send]')).toHaveLength(2));
    expect(container.querySelector(`[data-compare-row="${x}"] [data-compare-added]`)?.textContent).toContain('only-first.txt');
    expect(container.querySelector(`[data-compare-row="${y}"] [data-compare-missing]`)?.textContent).toContain('only-first.txt');
    expect(container.querySelector(`[data-compare-row="${x}"] [data-compare-model]`)?.textContent).toContain('one');
    expect(container.querySelector(`[data-compare-row="${y}"] [data-compare-model]`)?.textContent).toContain('two');
    expect(posted).toEqual([]);
  });

  it('[T29] each is sent by its own button, and only that one', async () => {
    const x = task('p/one', 'First?');
    const y = task('p/two', 'Second?');
    const { container } = await show([x, y]);
    await vi.waitFor(() => expect(container.querySelectorAll('[data-compare-send]')).toHaveLength(2));
    await during(async () => { (container.querySelector(`[data-compare-row="${y}"] [data-compare-send]`) as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].model).toBe('p/two');
  });

  it('[T29] a task that cannot be prepared says so, and the other can still be looked at', async () => {
    const x = task('p/one', 'First?');
    const y = task('p/two', 'Second?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, target: undefined } } : n)) }));
    const { container } = await show([x, y]);
    await vi.waitFor(() => expect(container.querySelector(`[data-compare-row="${x}"] [data-compare-blocked]`)).toBeTruthy());
    expect(container.querySelector(`[data-compare-row="${y}"] [data-compare-send]`)).toBeTruthy();
  });
});
