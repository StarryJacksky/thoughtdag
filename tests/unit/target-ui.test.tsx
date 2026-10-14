import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TargetContextDropzone from '../../src/components/agents/TargetContextDropzone';
import TargetPicker, { PerTaskAiToggle } from '../../src/components/agents/TargetPicker';
import SurfaceManager from '../../src/components/surfaces/SurfaceManager';
import { connectNode, createTarget, newTask, retarget, targetOf, templateFor } from '../../src/lib/agents/targets';
import HeaderActions from '../../src/components/focus-panel/HeaderActions';
import { buildContext } from '../../src/store/context-builder';
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

describe('what a task is wired to, sent with and typed into while things change (third review)', () => {
  const OTHER = 'canvas-2';
  const wait = (ms: number) => during(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** Another canvas is opened as the app does it: its graph is put in the store while `switching` is set, then the active id changes. */
  const openCanvas = (id: string, graph: { nodes: ReturnType<typeof useStore.getState>['nodes']; edges: ReturnType<typeof useStore.getState>['edges'] }) => {
    useProjects.setState({ switching: true });
    useStore.setState({ nodes: structuredClone(graph.nodes), edges: structuredClone(graph.edges) });
    useProjects.setState({ activeId: id, switching: false });
  };
  const withQuestion = (id: string, question: string, answer = '') => useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, response: answer, responses: answer ? [answer] : [], responseIndex: answer ? 0 : -1 } } : n)),
  }));
  const contextOf = (id: string) => buildContext(id, useStore.getState().nodes, useStore.getState().edges).messages.map((m) => m.content).join('\n');

  for (const kind of ['file-ref', 'selection-ref'] as const) {
    for (const route of [['B'], ['B', 'A']]) {
      it(`[R3-03] material dropped on a task (${kind}) whose wait ends after A→${route.join('→')} is wired into no task and no question`, async () => {
        useProjects.setState((s) => ({ projects: [...s.projects, { id: OTHER, name: 'copy', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }] }));
        const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
        withQuestion(x, 'X_TASK: summarise.');
        const a = { nodes: structuredClone(useStore.getState().nodes), edges: [] };
        // B was imported from a copy of A: the same task id, bound to another AI there
        const b = { nodes: a.nodes.map((n) => ({ ...n, data: { ...n.data, target: createTarget(templateFor(CLAUDE_CODE)), model: CLAUDE_CODE } })), edges: [] };
        const entryId = shell.seed('notes/one.md', 'A_PRIVATE_SYNTHETIC\n');
        const fileId = [...shell.files.values()].find((f) => f.relativePath === 'notes/one.md')!.fileId;
        view = await mount(<TargetContextDropzone nodeId={x} />);
        const zone = view.container.querySelector<HTMLElement>('[data-target-dropzone]')!;
        const slow = shell.holdNext(kind === 'file-ref' ? 'registerEntry' : 'reconcile');
        await during(async () => {
          dropOn(zone, kind === 'file-ref'
            ? { kind, workspaceId: 'ws_1', entryId, name: 'one.md' }
            : { kind, workspaceId: 'ws_1', name: 'one.md', ref: { fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' } });
          await settled();
        });
        for (const id of route) await during(() => openCanvas(id === 'B' ? OTHER : CANVAS, id === 'B' ? b : a));
        useUiStore.setState({ toasts: [] });
        slow.release();
        for (let i = 0; i < 10; i++) await during(settled);
        expect(useStore.getState().nodes.map((n) => n.id), 'no node was added').toEqual([x]);
        expect(useStore.getState().edges, 'and nothing was wired').toEqual([]);
        expect(contextOf(x)).not.toContain('A_PRIVATE_SYNTHETIC');
        expect(desktop.runs).toEqual([]);
        expect(useUiStore.getState().toasts, 'nothing is said about it on the canvas that is open').toEqual([]);
      });
    }
  }

  it('[R3-03] material dropped with nothing in between is wired to the task it was dropped on', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    const entryId = shell.seed('notes/one.md', 'A_PRIVATE_SYNTHETIC\n');
    view = await mount(<TargetContextDropzone nodeId={x} />);
    const zone = view.container.querySelector<HTMLElement>('[data-target-dropzone]')!;
    await during(async () => { dropOn(zone, { kind: 'file-ref', workspaceId: 'ws_1', entryId, name: 'one.md' }); for (let i = 0; i < 40 && edgesInto(x).length === 0; i++) await settled(); });
    expect(edgesInto(x).length).toBe(1);
    withQuestion(x, 'X_TASK: summarise.');
    expect(contextOf(x)).toContain('A_PRIVATE_SYNTHETIC');
  });

  it('[R3-12] a task\'s panel names the AI and effort the task runs on, and an effort chosen there is that task\'s alone', async () => {
    const x = newTask(createTarget(templateFor(CODEX, { effort: 'low' })), { x: 0, y: 0 });
    const y = newTask(createTarget(templateFor(CODEX)), { x: 600, y: 0 });
    withQuestion(x, 'X_TASK: write the paragraph.', 'an earlier answer');
    expect(targetOf(y)!.effort).toBe('high');
    view = await mount(<HeaderActions nodeId={x} isLoading={false} />);
    expect(view.container.textContent, 'the panel says what X runs on').toContain('gpt-synthetic · low');
    await during(() => view!.container.querySelector<HTMLElement>('[data-target-chip]')!.click());
    await during(() => view!.container.querySelector<HTMLElement>('[data-target-effort="medium"]')!.click());
    expect(targetOf(x)).toMatchObject({ model: CODEX, effort: 'medium' });
    expect(targetOf(y)!.effort, 'the other task keeps its own').toBe('high');
    expect(useUiStore.getState().agentEffort, 'and the default for new tasks is not touched').toBe('high');
    expect(view.container.textContent).toContain('gpt-synthetic · medium');
    // what it runs with is what it says: rerun in place, and a sibling
    const before = desktop.runs.length;
    await useStore.getState().rerunNode(x);
    expect(desktop.runs[before]).toMatchObject({ runtime: 'codex', effort: 'medium' });
    await useStore.getState().regenerate(x);
    expect(desktop.runs[before + 1]).toMatchObject({ runtime: 'codex', effort: 'medium' });
  });

  it('[R3-12] the panel of a task in a surface names the task\'s own effort too', async () => {
    const x = newTask(createTarget(templateFor(CODEX, { effort: 'low' })), { x: 0, y: 0 });
    withQuestion(x, 'X_TASK: write the paragraph.');
    view = await mount(<SurfaceManager />);
    let sx = '';
    await during(() => { sx = openTaskSurface(x, 'X'); });
    expect(view.container.querySelector(`[data-surface="${sx}"]`)!.textContent).toContain('gpt-synthetic · low');
  });

  for (const [what, to] of [['another runtime', { model: CLAUDE_CODE, effort: 'low' }], ['another effort', { model: CODEX, effort: 'low' }]] as const) {
    it(`[R3-13] a task given ${what} while its run is being prepared is sent as it was when the run began, model and effort together`, async () => {
      const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
      let arrived = () => {};
      const atGuard = new Promise<void>((resolve) => { arrived = resolve; });
      let letGo = () => {};
      const held = new Promise<void>((resolve) => { letGo = resolve; });
      window.desktopAgents!.guardWrite = async () => { arrived(); await held; return true; };
      const running = useStore.getState().editQuestion(x, 'X_TASK: write the paragraph.');
      await atGuard;
      retarget(x, to);
      letGo();
      await running;
      expect(desktop.runs).toHaveLength(1);
      expect(desktop.runs[0]).toMatchObject({ runtime: 'codex', model: { id: 'gpt-synthetic' }, effort: 'high' });
      expect(targetOf(x), 'the change is the next run\'s').toMatchObject(to);
    });
  }

  it('[R3-14] a task\'s panel opened a moment before another is brought to the front does not take the typing from it', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    const y = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 0 });
    withQuestion(x, 'X_TASK: write the paragraph.', 'an answer');
    withQuestion(y, 'Y_TASK: draft the reply.', 'an answer');
    view = await mount(<SurfaceManager />);
    let sb = '';
    await during(() => { sb = openTaskSurface(y, 'B'); });
    await wait(150);
    await during(() => { openTaskSurface(x, 'A'); });
    // at once, the person brings B forward by its title bar, to type there
    await during(() => { view!.container.querySelector(`[data-surface="${sb}"] [data-surface-titlebar]`)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    await wait(200);
    const frameB = view.container.querySelector<HTMLElement>(`[data-surface="${sb}"]`)!;
    expect(useSurfaces.getState().active.surfaceId).toBe(sb);
    expect(frameB.contains(document.activeElement), 'the keys go to B').toBe(true);
    // and what is typed there goes to B's AI
    const box = document.activeElement as HTMLTextAreaElement;
    expect(box.tagName).toBe('TEXTAREA');
    const before = desktop.runs.length;
    await during(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'MEANT_FOR_B: shorter.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await settled();
    });
    await during(async () => { frameB.querySelector<HTMLElement>('[data-followup-send]')!.click(); for (let i = 0; i < 40 && desktop.runs.length === before; i++) await settled(); });
    expect(desktop.runs[before]).toMatchObject({ runtime: 'claude-code' });
  });

  it('[L05] a sibling of a task with two pieces of material wired in is asked with both, on the task\'s AI', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A_ONLY_K7: trimmed mean.\n'), { x: -600, y: 0 });
    const b = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/b.md', 'B_ONLY_Q9: robustness.\n'), { x: -600, y: 300 });
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    connectNode(a, x);
    connectNode(b, x);
    await useStore.getState().editQuestion(x, 'X_TASK: compare them.');
    const seenBy = (run: number, materialsFrom: number) => [desktop.runs[run].prompt, ...desktop.materials.slice(materialsFrom).flatMap((m) => m.files.map((f) => (f.encoding === 'base64' ? atob(f.content) : f.content)))].join('\n');
    expect(seenBy(0, 0)).toContain('A_ONLY_K7');
    expect(seenBy(0, 0)).toContain('B_ONLY_Q9');
    const runsBefore = desktop.runs.length;
    const materialsBefore = desktop.materials.length;
    const answersBefore = node(x).data.responses;
    await useStore.getState().regenerate(x);
    const sibling = useStore.getState().selectedNodeId!;
    expect(sibling).not.toBe(x);
    expect(edgesInto(sibling).map((e) => e.source).sort()).toEqual([a, b].sort());
    expect(desktop.runs[runsBefore]).toMatchObject({ runtime: 'codex' });
    expect(seenBy(runsBefore, materialsBefore)).toContain('A_ONLY_K7');
    expect(seenBy(runsBefore, materialsBefore), 'the second piece of material too').toContain('B_ONLY_Q9');
    expect(edgesInto(x).map((e) => e.source).sort(), 'the task keeps its own').toEqual([a, b].sort());
    expect(node(x).data.responses).toEqual(answersBefore);
  });

  it('[L06] a task that names no model, when no model is known anywhere, is not sent, and gets no answer it did not have', async () => {
    desktop.uninstall(); // the web app: no runtimes that remember models of their own
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => { asked.push(String(url)); throw new Error('no network in tests'); });
    setModelsCache({ models: [], default: null });
    useUiStore.getState().setSelectedModel(null);
    // a task from before tasks had targets: no target, no model of its own
    const old = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === old ? { ...n, data: { ...n.data, target: undefined, model: undefined, question: 'OLD_TASK', response: 'an old answer', responses: ['an old answer'], responseIndex: 0 } } : n)) }));
    await useStore.getState().rerunNode(old);
    await useStore.getState().rerunNode(old, { auto: true });
    await useStore.getState().regenerate(old);
    for (let i = 0; i < 5; i++) await during(settled);
    expect(asked.filter((url) => url.includes('/api/stream')), 'nothing was sent for the server to pick a model for').toEqual([]);
    expect(node(old).data.responses).toEqual(['an old answer']);
    expect(node(old).data.generatedBy ?? []).toEqual([]);
    expect(node(old).data.isLoading).toBe(false);
    const sibling = useStore.getState().nodes.find((n) => n.id !== old)!;
    expect(sibling.data.responses).toEqual([]);
    expect(sibling.data.isLoading).toBe(false);
  });
});
