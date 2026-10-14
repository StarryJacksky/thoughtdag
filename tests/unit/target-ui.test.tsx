import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TargetContextDropzone from '../../src/components/agents/TargetContextDropzone';
import TargetPicker, { PerTaskAiToggle } from '../../src/components/agents/TargetPicker';
import SurfaceManager from '../../src/components/surfaces/SurfaceManager';
import { connectNode, createTarget, newTask, targetOf, templateFor } from '../../src/lib/agents/targets';
import { closeSurface, openTaskSurface, useSurfaces } from '../../src/lib/documents/surface-store';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { attachEntry, RESOURCE_DRAG_TYPE } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';
import { during, mount, type Mounted } from '../helpers/render';

// What a person sees and does with AI tasks: the chip that names a task's
// AI and lets it be changed, the strip that material is dropped on, and a
// panel per task beside the canvas. The lists and the names are checked as
// drawn; the drops are real DOM events carrying the app's own drag payload.

const CODEX = 'codex/gpt-synthetic';
const CLAUDE_CODE = 'claude/claude-code/sonnet';
const CLAUDE_API = 'synthetic-provider/claude-sonnet';
const CANVAS = 'canvas-1';
const model = (id: string, more: Record<string, unknown> = {}) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') || id.startsWith('claude/') ? '__agent__' : id.split('/')[0], vision: false, ...more });

let desktop: FakeDesktop;
let shell: FakeWorkspace;
let view: Mounted | null = null;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const edgesInto = (id: string) => useStore.getState().edges.filter((e) => e.target === id);
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
/** A drop of the app's own drag payload on an element. */
const dropOn = (el: Element, payload: unknown) => {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const type of ['dragover', 'drop']) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { types: [RESOURCE_DRAG_TYPE], getData: (t: string) => (t === RESOURCE_DRAG_TYPE ? raw : ''), dropEffect: 'none' } });
    el.dispatchEvent(event);
  }
};

beforeAll(() => bootProjects());
const MODELS = () => ({ models: [model(CODEX, { efforts: ['low', 'medium', 'high'] }), model(CLAUDE_CODE), model(CLAUDE_API)], default: null });

beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useSurfaces.setState({ surfaces: [], order: [], container: { width: 1400, height: 900 }, active: { surfaceId: null, turn: 0 } });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [] });
  useUiStore.getState().setSelectedModel(CODEX);
  useUiStore.getState().setAgentEffort('high');
  // the chip that chooses an AI for one task is there only when choosing per task is turned on; these tests turn it on
  useUiStore.getState().setPerTaskAi(true);
  // The first picker to open asks the runtimes for their models, once per launch, and the stand-in shell
  // has none to report. That asking is done here, before the list the tests use is put in place.
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
});
afterEach(async () => {
  await view?.unmount();
  view = null;
  for (const s of [...useSurfaces.getState().surfaces]) closeSurface(s.surfaceId);
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
  useUiStore.getState().setAgentEffort('');
  useUiStore.getState().setPerTaskAi(false);
});

describe('the chip on a task', () => {
  it('names the AI the task is bound to, runtime first for an agent', async () => {
    const x = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 0, y: 0 });
    view = await mount(<TargetPicker nodeId={x} />);
    const chip = view.container.querySelector<HTMLElement>('[data-target-chip]')!;
    expect(chip.dataset.targetChip).toBe('bound');
    expect(chip.querySelector('[data-target-label]')!.textContent).toBe('Claude Code · sonnet · high');
  });

  it('lists agents and API models in two groups, and gives a model called through its API no agent\'s name', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    view = await mount(<TargetPicker nodeId={x} />);
    await during(() => view!.container.querySelector<HTMLElement>('[data-target-chip]')!.click());
    const options = [...view.container.querySelectorAll<HTMLElement>('[data-target-option]')];
    expect(options.map((o) => [o.dataset.targetOption, o.dataset.targetGroup])).toEqual([[CODEX, 'agent'], [CLAUDE_CODE, 'agent'], [CLAUDE_API, 'api']]);
    const text = (id: string) => options.find((o) => o.dataset.targetOption === id)!.textContent!;
    expect(text(CLAUDE_CODE)).toBe('Claude Code · sonnet');
    expect(text(CLAUDE_API)).toBe('claude-sonnet');
    expect(text(CLAUDE_API)).not.toContain('Claude Code');
    // the two groups have their own headings, in this order
    const headings = [...view.container.querySelectorAll<HTMLElement>('[data-target-heading]')].map((h) => h.dataset.targetHeading);
    expect(headings).toEqual(['agent', 'api']);
    const menu = view.container.querySelector('[data-target-menu]')!;
    const order = [...menu.querySelectorAll('[data-target-heading], [data-target-option]')].map((el) => (el as HTMLElement).dataset.targetHeading ?? (el as HTMLElement).dataset.targetGroup);
    expect(order).toEqual(['agent', 'agent', 'agent', 'api', 'api']);
  });

  it('gives this task another AI when one is picked, and leaves the other task with its own', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    const y = newTask(createTarget(templateFor(CODEX)), { x: 600, y: 0 });
    const wasY = targetOf(y)!;
    view = await mount(<TargetPicker nodeId={x} />);
    await during(() => view!.container.querySelector<HTMLElement>('[data-target-chip]')!.click());
    await during(() => view!.container.querySelector<HTMLElement>(`[data-target-option="${CLAUDE_API}"]`)!.click());
    expect(targetOf(x)).toMatchObject({ model: CLAUDE_API, kind: 'provider', runtime: null, effort: null });
    expect(view.container.querySelector('[data-target-label]')!.textContent).toBe('claude-sonnet · API');
    expect(targetOf(y)).toEqual(wasY);
    expect(desktop.runs, 'choosing an AI sends nothing').toEqual([]);
  });

  it('offers the efforts the runtime says the model takes, and sets the one picked on this task only', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    view = await mount(<TargetPicker nodeId={x} />);
    await during(() => view!.container.querySelector<HTMLElement>('[data-target-chip]')!.click());
    expect([...view.container.querySelectorAll<HTMLElement>('[data-target-effort]')].map((b) => b.dataset.targetEffort)).toEqual(['low', 'medium', 'high']);
    await during(() => view!.container.querySelector<HTMLElement>('[data-target-effort="low"]')!.click());
    expect(targetOf(x)).toMatchObject({ model: CODEX, effort: 'low' });
    expect(useUiStore.getState().agentEffort, 'the global effort is not touched').toBe('high');
  });

  it('says what a task with no target yet will be bound to, and that it is not bound yet', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, target: undefined, model: undefined } } : n)) }));
    view = await mount(<TargetPicker nodeId={x} />);
    const chip = view.container.querySelector<HTMLElement>('[data-target-chip]')!;
    expect(chip.dataset.targetChip).toBe('unbound');
    expect(chip.textContent).toContain('Codex · gpt-synthetic');
    expect(chip.textContent).toContain('toolbar');
  });
});

describe('choosing an AI for each task', () => {
  const unbound = (id: string, x = 0) => {
    useStore.setState((st) => ({ nodes: [...st.nodes, { id, type: 'thought' as const, position: { x, y: 0 }, data: { question: '', response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'tag' as const, roleMode: 'inherit' as const, attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], isRoot: false, isBranch: false } }] }));
    return id;
  };

  it('is off unless it is turned on: a task shows no chooser, and is sent to the toolbar\'s AI', async () => {
    useUiStore.getState().setPerTaskAi(false);
    const x = unbound('q1');
    view = await mount(<TargetPicker nodeId={x} />);
    expect(view.container.querySelector('[data-target-chip]')).toBeNull();
    await useStore.getState().editQuestion(x, 'Q_TASK: summarize.');
    expect(desktop.runs[0]).toMatchObject({ runtime: 'codex', model: { provider: 'codex', id: 'gpt-synthetic' } });
  });

  it('is turned on and off from the toolbar, and remembered', async () => {
    useUiStore.getState().setPerTaskAi(false);
    view = await mount(<PerTaskAiToggle />);
    const toggle = view.container.querySelector<HTMLElement>('[data-per-task-ai]')!;
    expect(toggle.dataset.perTaskAi).toBe('off');
    await during(() => toggle.click());
    expect(useUiStore.getState().perTaskAi).toBe(true);
    expect(localStorage.getItem('thoughtdag.perTaskAi')).toBe('1');
    expect(view.container.querySelector<HTMLElement>('[data-per-task-ai]')!.dataset.perTaskAi).toBe('on');
    await during(() => view!.container.querySelector<HTMLElement>('[data-per-task-ai]')!.click());
    expect(useUiStore.getState().perTaskAi).toBe(false);
    expect(localStorage.getItem('thoughtdag.perTaskAi')).toBeNull();
  });

  it('once on, every task still starts on the toolbar\'s AI; only the one that is given another changes', async () => {
    const x = unbound('q1');
    const y = unbound('q2', 600);
    view = await mount(<div><TargetPicker nodeId={x} /><TargetPicker nodeId={y} /></div>);
    const chips = () => [...view!.container.querySelectorAll<HTMLElement>('[data-target-chip]')];
    // nothing to choose for either: both say they go to the toolbar's AI
    expect(chips().map((chip) => chip.dataset.targetChip)).toEqual(['unbound', 'unbound']);
    expect(chips().every((chip) => chip.textContent!.includes('Codex · gpt-synthetic'))).toBe(true);
    // one of them is given another AI
    await during(() => chips()[1].click());
    await during(() => view!.container.querySelector<HTMLElement>(`[data-target-option="${CLAUDE_API}"]`)!.click());
    expect(targetOf(y)).toMatchObject({ model: CLAUDE_API });
    expect(targetOf(x), 'the other is not touched').toBeUndefined();
    // the toolbar changes: the task nobody chose for follows it until it is sent; the chosen one keeps its own
    await during(() => useUiStore.getState().setSelectedModel(CLAUDE_CODE));
    expect(chips()[0].textContent).toContain('Claude Code · sonnet');
    expect(chips()[1].textContent).toContain('claude-sonnet · API');
    // turned off again: the choosers go, the choice stays
    await during(() => useUiStore.getState().setPerTaskAi(false));
    expect(chips()).toEqual([]);
    expect(targetOf(y)).toMatchObject({ model: CLAUDE_API });
  });
});

describe('the strip material is dropped on', () => {
  const setup = async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A_ONLY_K7: trimmed mean.\n'), { x: 0, y: 0 });
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 400 });
    view = await mount(<TargetContextDropzone nodeId={x} />);
    return { a, x, zone: view.container.querySelector<HTMLElement>('[data-target-dropzone]')! };
  };

  it('wires a node dropped on it to this task, says how many things are wired in, and sends nothing', async () => {
    const { a, x, zone } = await setup();
    expect(zone.querySelector<HTMLElement>('[data-target-inputs]')!.dataset.targetInputs).toBe('0');
    await during(async () => { dropOn(zone, { kind: 'graph-node', nodeId: a }); await settled(); });
    expect(edgesInto(x).map((e) => e.source)).toEqual([a]);
    expect(zone.querySelector<HTMLElement>('[data-target-inputs]')!.dataset.targetInputs).toBe('1');
    expect(desktop.runs).toEqual([]);
    expect(node(x).data.isLoading).toBe(false);
    expect(shell.calls.map((c) => c.method).filter((m) => ['moveFile', 'copyFile', 'trashFile', 'saveText'].includes(m))).toEqual([]);
  });

  it('wires a file dropped from the tree through a node for it, made beside the task', async () => {
    const { x, zone } = await setup();
    const entryId = shell.seed('notes/b.md', 'B_ONLY_Q9: robustness.\n');
    await during(async () => { dropOn(zone, { kind: 'file-ref', workspaceId: 'ws_1', entryId, name: 'b.md' }); for (let i = 0; i < 40 && edgesInto(x).length === 0; i++) await settled(); });
    const [edge] = edgesInto(x);
    expect(node(edge.source).data.resourceHint).toMatchObject({ name: 'b.md' });
    expect(desktop.runs).toEqual([]);
    expect(shell.files.get(node(edge.source).data.resourceRef!.fileId)).toMatchObject({ relativePath: 'notes/b.md', content: 'B_ONLY_Q9: robustness.\n' });
  });

  it('takes nothing that is not a reference by id: a path, a folder, or something malformed', async () => {
    const { x, zone } = await setup();
    const callsBefore = shell.calls.length;
    await during(async () => {
      dropOn(zone, { kind: 'file-ref', workspaceId: 'ws_1', entryId: 'e', name: 'a.md', path: '/synthetic/a.md' });
      dropOn(zone, { kind: 'folder-ref', workspaceId: 'ws_1', entryId: shell.entryId('notes'), name: 'notes' });
      dropOn(zone, 'not json');
      await settled();
    });
    expect(edgesInto(x)).toEqual([]);
    expect(shell.calls.slice(callsBefore), 'the workspace was not asked for anything').toEqual([]);
  });

  it('refuses to wire a task\'s own answer back into it, and says why', async () => {
    const { x, zone } = await setup();
    const y = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 400 });
    connectNode(x, y);
    useUiStore.setState({ toasts: [] });
    const before = useStore.getState().edges.length;
    await during(async () => { dropOn(zone, { kind: 'graph-node', nodeId: y }); await settled(); });
    expect(useStore.getState().edges.length).toBe(before);
    expect(useUiStore.getState().toasts.map((toast) => toast.kind)).toEqual(['error']);
  });
});

describe('a panel for each task, in the one window', () => {
  const ask = async (task: string, question: string) => { await useStore.getState().editQuestion(task, question); };

  it('two tasks have their panels open side by side, each showing its own task; closing one leaves the other', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    const y = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 0 });
    await ask(x, 'X_TASK: write the paragraph.');
    await ask(y, 'Y_TASK: draft the reply.');
    view = await mount(<SurfaceManager />);
    let sx = '';
    let sy = '';
    await during(() => { sx = openTaskSurface(x, 'X'); sy = openTaskSurface(y, 'Y'); });
    const frames = [...view.container.querySelectorAll<HTMLElement>('[data-surface]')];
    expect(frames.length).toBe(2);
    const panelOf = (surfaceId: string) => view!.container.querySelector<HTMLElement>(`[data-surface="${surfaceId}"] [data-task-panel]`)!;
    expect(panelOf(sx).dataset.taskPanel).toBe(x);
    expect(panelOf(sy).dataset.taskPanel).toBe(y);
    expect(panelOf(sx).textContent).toContain('X_TASK: write the paragraph.');
    expect(panelOf(sx).textContent).not.toContain('Y_TASK');
    expect(panelOf(sy).textContent).toContain('Y_TASK: draft the reply.');
    // they are frames in the surface layer of this window, not windows: both are in this document, in different places
    expect(frames.every((frame) => frame.ownerDocument === document)).toBe(true);
    expect(frames[0].style.left).not.toBe(frames[1].style.left);
    expect(useSurfaces.getState().surfaces.map((s) => s.kind)).toEqual(['task', 'task']);

    // opening a task's panel again brings the one it has to the front
    await during(() => { expect(openTaskSurface(x, 'X')).toBe(sx); });
    expect(useSurfaces.getState().order.at(-1)).toBe(sx);
    await during(() => closeSurface(sx));
    expect(view.container.querySelectorAll('[data-surface]').length).toBe(1);
    expect(panelOf(sy).textContent).toContain('Y_TASK: draft the reply.');
    expect(node(x), 'closing a panel removes nothing from the canvas').toBeDefined();
  });

  it('a follow-up typed in one task\'s panel goes to that task\'s AI', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    const y = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 0 });
    await ask(x, 'X_TASK: write the paragraph.');
    await ask(y, 'Y_TASK: draft the reply.');
    view = await mount(<SurfaceManager />);
    let sy = '';
    await during(() => { openTaskSurface(x, 'X'); sy = openTaskSurface(y, 'Y'); });
    const box = view.container.querySelector<HTMLTextAreaElement>(`[data-surface="${sy}"] textarea`)!;
    const before = desktop.runs.length;
    await during(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Y_FOLLOW_UP: shorter.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await settled();
    });
    await during(async () => { view!.container.querySelector<HTMLElement>(`[data-surface="${sy}"] [data-followup-send]`)!.click(); for (let i = 0; i < 40 && desktop.runs.length === before; i++) await settled(); });
    expect(desktop.runs[before]).toMatchObject({ runtime: 'claude-code' });
    expect(desktop.runs[before].prompt.endsWith('Y_FOLLOW_UP: shorter.')).toBe(true);
  });

  it('does not offer to send when the task\'s model cannot be reached, and says so in the panel', async () => {
    const x = newTask(createTarget(templateFor(CLAUDE_API)), { x: 0, y: 0 });
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, question: 'P_TASK', response: 'an earlier answer', responses: ['an earlier answer'], responseIndex: 0 } } : n)) }));
    setModelsCache({ models: [model('other-provider/claude-sonnet')], default: 'other-provider/claude-sonnet' });
    view = await mount(<SurfaceManager />);
    let sx = '';
    await during(() => { sx = openTaskSurface(x, 'P'); });
    const frame = view.container.querySelector<HTMLElement>(`[data-surface="${sx}"]`)!;
    const send = frame.querySelector<HTMLButtonElement>('[data-followup-send]')!;
    expect(send.dataset.followupSend).toBe('unavailable');
    expect(send.disabled).toBe(true);
    expect(frame.querySelector('[data-followup-blocked="unavailable"]')!.textContent).toContain(CLAUDE_API);
  });

  it('goes away when its task is removed from the canvas', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    await ask(x, 'X_TASK: write the paragraph.');
    view = await mount(<SurfaceManager />);
    await during(() => { openTaskSurface(x, 'X'); });
    await during(() => { useStore.setState((st) => ({ nodes: st.nodes.filter((n) => n.id !== x) })); });
    expect(useSurfaces.getState().surfaces).toEqual([]);
  });
});
