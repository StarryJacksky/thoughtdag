import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, newTask, retarget, setRunMode, templateFor } from '../../src/lib/agents/targets';
import { bootAutoBackup, disableAutoBackup } from '../../src/lib/local-backup';
import { useUiStore } from '../../src/lib/ui-store';
import { setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// What the review of the upstream 0.5.26 merge found on the page side (its
// R9 numbers are kept in the test names): an automatic backup that failed
// said nothing and was not tried again, and undoing a switch of a task's AI
// took back the target but left the model it had been switched to. All of
// it on stand-ins for the desktop shell, with synthetic canvases.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_A = 'synthetic-a/model-a';
const API_B = 'synthetic-b/model-b';
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false, ...(id.startsWith('codex/') ? { efforts: ['low', 'medium', 'high'] } : {}) });
const MODELS = () => ({ models: [model(CODEX), model(API_A), model(API_B)], default: null });

let desktop: FakeDesktop;
let shell: FakeWorkspace;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;

function thought(id: string, data: Partial<ThoughtNode['data']>): ThoughtNode {
  return {
    id, type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle',
    data: {
      question: '', response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 0, highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [],
      roleMode: 'inherit', isRoot: false, isBranch: false, ...data,
    },
  };
}

beforeAll(() => bootProjects());
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [] });
  useUiStore.getState().setSelectedModel(CODEX);
});
afterEach(() => {
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

// ── R9-01: an automatic backup that fails ──────────────────────────────

describe('[R9-01] the automatic backup', () => {
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  /** every error toast shown since the test began, and those still on screen */
  let shown: string[] = [];
  let unsubscribe = () => {};
  const errors = () => shown;
  const onScreen = () => useUiStore.getState().toasts.filter((x) => x.kind === 'error').map((x) => x.message);
  beforeEach(() => {
    shown = [];
    unsubscribe = useUiStore.subscribe((s, prev) => {
      for (const x of s.toasts) if (x.kind === 'error' && !prev.toasts.some((p) => p.id === x.id)) shown.push(x.message);
    });
  });

  afterEach(async () => {
    unsubscribe();
    // the stand-in for IndexedDB runs on timers: real ones again before the folder is let go
    vi.useRealTimers();
    await disableAutoBackup();
    localStorage.removeItem('thoughtdag.lastBackupAt');
    useUiStore.getState().setLastAutoBackupAt(null);
  });

  it('[R9-01] says once that a backup could not be written, tries again without another change, and moves the time of the last backup only when one is written', async () => {
    vi.useFakeTimers();
    let answers = ['fail', 'fail', 'ok'];
    const backupJson = vi.fn(async (_dir: string, name: string) => {
      const next = answers.shift() ?? 'ok';
      if (next === 'fail') throw new Error('ENOSPC: the disk is full');
      return { file: `/synthetic/backups/${name}` };
    });
    window.desktopAgents = { ...window.desktopAgents!, backupJson, pickCwd: async () => '/synthetic/backups' };
    localStorage.setItem('thoughtdag.backupDirPath', '/synthetic/backups');
    await bootAutoBackup();
    useStore.setState({ nodes: [thought('n1', { question: 'a change to back up', isRoot: true })] });

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(backupJson).toHaveBeenCalledTimes(1);
    expect(errors(), 'the failure is said where the person sees it').toHaveLength(1);
    expect(useUiStore.getState().lastAutoBackupAt, 'nothing was written: no time of a last backup').toBeNull();

    // nothing on the canvas changes; the backup is tried again anyway, and a second failure is not said twice
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(backupJson).toHaveBeenCalledTimes(2);
    expect(errors()).toHaveLength(1);
    expect(useUiStore.getState().lastAutoBackupAt).toBeNull();

    expect(onScreen(), 'and it stays where the person sees it while backups fail').toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(backupJson).toHaveBeenCalledTimes(3);
    expect(useUiStore.getState().lastAutoBackupAt, 'written: now there is a time').not.toBeNull();
    expect(onScreen(), 'and the failure is no longer said').toEqual([]);

    // once it is written, nothing more is written until the canvas changes
    await vi.advanceTimersByTimeAsync(180_000);
    await flush();
    expect(backupJson).toHaveBeenCalledTimes(3);
    answers = ['fail'];
    useStore.setState({ nodes: [thought('n1', { question: 'a later change', isRoot: true })] });
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(errors(), 'a new failure after a backup was written is said again').toHaveLength(2);
  });
});

// ── R9-04: undoing a switch of a task's AI ─────────────────────────────

describe('[R9-04] undoing a switch of a task\'s AI', () => {
  type Body = { model?: string };
  /** Answer API calls and agent runs; resolve with the AI the next send of `id` went to. */
  function routes() {
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
    return async (id: string): Promise<string> => {
      const runs = desktop.runs.length;
      const sent = bodies.length;
      await useStore.getState().rerunNode(id);
      if (desktop.runs.length > runs) return `agent:${desktop.runs[runs].runtime}:${desktop.runs[runs].effort ?? ''}`;
      expect(bodies.length, 'one request went out').toBe(sent + 1);
      return `api:${bodies[sent].model}`;
    };
  }
  const undo = () => useStore.getState().undo();
  const redo = () => useStore.getState().redo();
  const state = (id: string) => ({ model: node(id).data.model, targetModel: node(id).data.target?.model, effort: node(id).data.target?.effort, policy: node(id).data.target?.policyId });

  /** A task as an older canvas holds it: a model picked for it, no target. */
  function olderTask(modelId: string): string {
    useStore.setState((st) => ({ nodes: [...st.nodes, thought('old', { question: 'summarize the plan', response: 'an earlier answer', responses: ['an earlier answer'], responseIndex: 0, isRoot: true, model: modelId })] }));
    useStore.getState().pushHistory();
    return 'old';
  }

  beforeEach(() => setModelsCache(MODELS()));

  it('[R9-04] a task with only a model picked, switched to another AI and the switch undone, goes back to the model it had', async () => {
    const sendOf = routes();
    const id = olderTask(API_A);
    retarget(id, { model: API_B });
    expect(state(id)).toMatchObject({ model: API_B, targetModel: API_B });
    undo();
    expect(state(id), 'the model goes back with the target').toEqual({ model: API_A, targetModel: undefined, effort: undefined, policy: undefined });
    expect(await sendOf(id), 'and the next send goes to it').toBe(`api:${API_A}`);
  });

  it('[R9-04] a task bound to A, switched to B: undo and redo carry the target and its model together, and so does each send', async () => {
    const sendOf = routes();
    const id = newTask(createTarget(templateFor(API_A)), { x: 0, y: 0 });
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question: 'summarize the plan' } } : n)) }));
    useStore.getState().pushHistory();
    const a = node(id).data.target!;
    retarget(id, { model: API_B });
    const b = node(id).data.target!;
    undo();
    expect(node(id).data.target).toEqual(a);
    expect(node(id).data.model).toBe(API_A);
    redo();
    expect(node(id).data.target).toEqual(b);
    expect(node(id).data.model).toBe(API_B);
    expect(await sendOf(id)).toBe(`api:${API_B}`);
    // the send made an answer: undo takes that back first, then the switch
    undo();
    undo();
    expect(node(id).data.target).toEqual(a);
    expect(node(id).data.model).toBe(API_A);
    expect(await sendOf(id)).toBe(`api:${API_A}`);
  });

  it('[R9-04] from an API model to an agent and back: runtime, effort and run mode all come back with the model', async () => {
    const sendOf = routes();
    const id = newTask(createTarget(templateFor(API_A)), { x: 0, y: 0 });
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question: 'summarize the plan' } } : n)) }));
    useStore.getState().pushHistory();
    const onApi = state(id);
    retarget(id, { model: CODEX, effort: 'low' });
    const atWork = state(id);
    expect(atWork).toMatchObject({ model: CODEX, targetModel: CODEX, effort: 'low' });
    setRunMode(id, 'research');
    const inResearch = state(id);
    expect(inResearch.policy).not.toBe(atWork.policy);
    undo(); // the run mode
    expect(state(id)).toEqual(atWork);
    undo(); // the switch to the agent
    expect(state(id)).toEqual(onApi);
    expect(state(id)).toMatchObject({ model: API_A, targetModel: API_A });
    redo();
    redo();
    expect(state(id)).toEqual(inResearch);
    undo();
    expect(state(id)).toEqual(atWork);
    expect(await sendOf(id), 'the agent at work, with its effort').toBe('agent:codex:low');
    undo(); // the answer
    undo(); // the switch to the agent
    expect(state(id)).toEqual(onApi);
    expect(await sendOf(id)).toBe(`api:${API_A}`);
  });

  it('[R9-04] a model picked on a task with no target is still a setting: undoing an earlier step keeps it', () => {
    const id = olderTask(API_A);
    useStore.setState((st) => ({ nodes: [...st.nodes, thought('note', { question: 'a step to take back', stepKind: 'note', isRoot: true })] }));
    useStore.getState().pushHistory();
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, model: API_B } } : n)) }));
    undo();
    expect(useStore.getState().nodes.some((n) => n.id === 'note')).toBe(false);
    expect(node(id).data.model).toBe(API_B);
    expect(node(id).data.target).toBeUndefined();
  });
});
