import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import RunPreview from '../../src/components/workspace/RunPreview';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, type Mounted } from '../helpers/render';

// The run preview on a task's panel: the mode it runs in and what that
// means for its AI, said before anything is sent, and what it is given and
// what is left out.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
let shell: FakeWorkspace;
let desktop: FakeDesktop;
let view: Mounted | null = null;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false });
const MODELS = () => ({ models: [model(CODEX), model(API_MODEL)], default: null });
const q = (selector: string) => view!.container.querySelector<HTMLElement>(selector);

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

describe('the run preview', () => {
  it('[T12] says, for an agent at work, that its tools can read more than its inputs', async () => {
    const t = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    view = await mount(<RunPreview nodeId={t} />);
    expect(q('[data-run-mode="workspace"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-run-notice="workspace-readable"]')).not.toBeNull();
  });

  it('[T12] says, for an agent set to research, that it will not be sent, and sets it back to work', async () => {
    const t = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    view = await mount(<RunPreview nodeId={t} />);
    await during(() => q('[data-run-mode="research"]')!.click());
    expect(node(t).data.target!.policyId).toBe('research');
    expect(q('[data-run-mode="research"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-run-notice="blocked"]')!.textContent).toContain('Codex');
    await during(() => q('[data-run-mode="workspace"]')!.click());
    expect(node(t).data.target!.policyId).toBe('default');
    expect(q('[data-run-notice="blocked"]')).toBeNull();
  });

  it('[T12] says, for an API model set to research, that only its inputs and question are sent', async () => {
    const t = newTask(createTarget(templateFor(API_MODEL)), { x: 0, y: 0 });
    view = await mount(<RunPreview nodeId={t} />);
    expect(q('[data-run-notice]')).toBeNull();
    await during(() => q('[data-run-mode="research"]')!.click());
    expect(q('[data-run-notice="research"]')).not.toBeNull();
  });

  it('[T12] lists what the task is given and what the person left out', async () => {
    const keep = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/keep.md', 'KEEP\n'), { x: 0, y: 0 });
    const secret = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/secret.md', 'SECRET\n'), { x: 300, y: 0 });
    const t = newTask(createTarget(templateFor(API_MODEL)), { x: 0, y: 600 });
    const left = node(secret).data.attachments[0].id;
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => (n.id === t ? { ...n, data: { ...n.data, question: 'What?', excludedAttachmentIds: [left] } } : n)),
      edges: [...st.edges, { id: 'e1', source: keep, target: t }, { id: 'e2', source: secret, target: t }],
    }));
    view = await mount(<RunPreview nodeId={t} />);
    expect(q('[data-run-inputs]')).toBeNull();
    await during(() => q('[data-run-preview-toggle]')!.click());
    expect(q(`[data-run-input="${keep}"]`)!.textContent).toContain('keep.md');
    expect(q(`[data-run-input="${secret}"]`)).toBeNull();
    expect(q(`[data-run-excluded="${secret}"]`)!.textContent).toContain('secret.md');
  });
});
