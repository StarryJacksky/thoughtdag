import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canSend, connectNode, connectSelection, createTarget, bindTarget, describeTarget, newTask, retarget, targetOf, templateFor, wouldLoop } from '../../src/lib/agents/targets';
import { validateRunDTO } from '../../src/lib/context/contracts';
import { useUiStore } from '../../src/lib/ui-store';
import { attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { buildContext } from '../../src/store/context-builder';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// AI tasks on one canvas, each bound to the AI it runs on. A target is made
// once, from a template; after that nothing global changes it. Material is
// wired to a task by an edge and by nothing else: wiring runs nothing and
// moves no file. Runs are observed at a stand-in for the desktop shell's
// agent bridge, so what is checked is what a real ask would send.

const CODEX = 'codex/gpt-synthetic';
const CLAUDE_CODE = 'claude/claude-code/sonnet';
const CLAUDE_API = 'synthetic-provider/claude-sonnet';
const CANVAS = 'canvas-1';

let desktop: FakeDesktop;
let shell: FakeWorkspace;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const edgesInto = (id: string) => useStore.getState().edges.filter((e) => e.target === id);
const contextOf = (id: string) => {
  const { nodes, edges } = useStore.getState();
  return buildContext(id, nodes, edges).messages.map((m) => m.content).join('\n');
};
/** Send a task's question the way its card does, and return what its run was handed. */
async function ask(taskId: string, question: string): Promise<DesktopAgentRunRequest> {
  const before = desktop.runs.length;
  await useStore.getState().editQuestion(taskId, question);
  expect(desktop.runs.length, `${question} started one run`).toBe(before + 1);
  return desktop.runs[before];
}
const note = (id: string, text: string) => ({ id, type: 'thought' as const, position: { x: 0, y: 0 }, data: { question: text, stepKind: 'note' as const, response: '', responses: [], responseIndex: -1, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off' as const, roleMode: 'inherit' as const, attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], isRoot: false, isBranch: false } });

beforeAll(() => bootProjects());
beforeEach(() => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.getState().setSelectedModel(CODEX);
  useUiStore.getState().setAgentEffort('high');
});
afterEach(() => {
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
  useUiStore.getState().setAgentEffort('');
});

describe('a target', () => {
  it('is made from a template with an identity of its own, and fits the contract', () => {
    const template = templateFor(CODEX);
    const one = createTarget(template);
    const two = createTarget(template);
    expect(validateRunDTO('ExecutionTarget', one).ok).toBe(true);
    expect(one).toMatchObject({ kind: 'agent', runtime: 'codex', model: CODEX, effort: 'high' });
    expect(one.targetId).not.toBe(two.targetId);
    expect(one.targetId).not.toBe(template.targetId);
    // the same settings are the same revision; other settings are another
    expect(one.revision).toBe(two.revision);
    expect(createTarget({ ...template, effort: 'low' }).revision).not.toBe(one.revision);
    expect(createTarget({ ...template, model: CLAUDE_CODE }).revision).not.toBe(one.revision);
  });

  it('takes the global defaults as they are when it is made, and is not changed when they change', async () => {
    const task = newTask(createTarget(templateFor()), { x: 0, y: 0 });
    const made = targetOf(task)!;
    expect(made).toMatchObject({ model: CODEX, effort: 'high' });

    useUiStore.getState().setSelectedModel(CLAUDE_CODE);
    useUiStore.getState().setAgentEffort('low');
    expect(targetOf(task)).toEqual(made);
    const run = await ask(task, 'T_TASK: which estimator?');
    expect(run).toMatchObject({ runtime: 'codex', model: { provider: 'codex', id: 'gpt-synthetic' }, effort: 'high' });
    // a target made now takes what the defaults are now
    expect(createTarget(templateFor())).toMatchObject({ model: CLAUDE_CODE, effort: 'low' });
  });

  it('does not call a model reached through its API by the name of the agent that runs the same family', () => {
    const agent = describeTarget(createTarget(templateFor(CLAUDE_CODE)));
    const api = describeTarget(createTarget(templateFor(CLAUDE_API)));
    expect(agent).toMatchObject({ group: 'agent', runtime: 'Claude Code' });
    expect(agent.label).toContain('Claude Code');
    expect(api).toMatchObject({ group: 'api', runtime: null });
    expect(api.label).not.toContain('Claude Code');
    expect(api.label).toContain('claude-sonnet');
    expect(api.label, 'an API model says that it is one').toMatch(/API/);
    expect(createTarget(templateFor(CLAUDE_API))).toMatchObject({ kind: 'provider', runtime: null });
  });

  it('is bound to a task by its id, on the canvas that is open and to a node that asks', () => {
    const made = createTarget(templateFor(CLAUDE_CODE));
    const task = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    bindTarget({ graphId: CANVAS, taskNodeId: task, targetId: made.targetId });
    expect(targetOf(task)).toEqual(made);
    expect(node(task).data.model, 'the line it starts follows it').toBe(CLAUDE_CODE);

    expect(() => bindTarget({ graphId: 'another-canvas', taskNodeId: task, targetId: made.targetId })).toThrow(/canvas/);
    expect(() => bindTarget({ graphId: CANVAS, taskNodeId: task, targetId: 'target_nobody_made' })).toThrow(/target/);
    useStore.setState((st) => ({ nodes: [...st.nodes, note('n1', 'a note')] }));
    expect(() => bindTarget({ graphId: CANVAS, taskNodeId: 'n1', targetId: made.targetId })).toThrow(/task/);
    expect(node('n1').data.target).toBeUndefined();
  });
});

describe('two tasks for two AIs on one canvas', () => {
  it('a Codex task and a Claude Code task are made side by side, and each runs on its own AI with its own settings', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    useUiStore.getState().setAgentEffort('low');
    const y = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 0 });
    expect(useStore.getState().nodes.map((n) => n.id).sort()).toEqual([x, y].sort());
    expect(targetOf(x)!.targetId).not.toBe(targetOf(y)!.targetId);

    const runY = await ask(y, 'Y_TASK: draft the reply.');
    const runX = await ask(x, 'X_TASK: write the paragraph.');
    expect(runX).toMatchObject({ runtime: 'codex', model: { provider: 'codex', id: 'gpt-synthetic' }, effort: 'high' });
    expect(runY).toMatchObject({ runtime: 'claude-code', model: { provider: 'claude-code', id: 'sonnet' }, effort: 'low' });
    expect(runX.sessionPath).toBeUndefined();
    expect(runY.sessionPath).toBeUndefined();
  });

  it('a question asked below a task goes to that task\'s AI, whatever the toolbar says by then', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    await ask(x, 'X_TASK: write the paragraph.');
    useUiStore.getState().setSelectedModel(CLAUDE_CODE);
    useUiStore.getState().setAgentEffort('low');
    const before = desktop.runs.length;
    await useStore.getState().addQuestion('X_FOLLOW_UP: shorter.', { parentId: x });
    expect(desktop.runs[before]).toMatchObject({ runtime: 'codex', effort: 'high' });
    const child = useStore.getState().nodes.find((n) => n.data.question === 'X_FOLLOW_UP: shorter.')!;
    expect(targetOf(child.id)!.targetId, 'the line is one target').toBe(targetOf(x)!.targetId);
  });

  it('a task that was never given a target is bound to what it first runs on, and stays on it', async () => {
    useStore.setState((st) => ({ nodes: [...st.nodes, { ...note('q1', ''), data: { ...note('q1', '').data, stepKind: undefined } }] }));
    expect(targetOf('q1')).toBeUndefined();
    const first = await ask('q1', 'Q_TASK: summarize.');
    expect(first).toMatchObject({ runtime: 'codex', effort: 'high' });
    expect(targetOf('q1')).toMatchObject({ model: CODEX, effort: 'high', kind: 'agent', runtime: 'codex' });

    useUiStore.getState().setSelectedModel(CLAUDE_CODE);
    useUiStore.getState().setAgentEffort('low');
    const before = desktop.runs.length;
    await useStore.getState().regenerate('q1');
    expect(desktop.runs[before]).toMatchObject({ runtime: 'codex', effort: 'high' });
  });

  it('a task given another AI by the person gets a target of its own; the task it was copied from keeps its own', async () => {
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    await ask(x, 'X_TASK: write the paragraph.');
    await useStore.getState().addQuestion('X_FOLLOW_UP: shorter.', { parentId: x });
    const child = useStore.getState().nodes.find((n) => n.data.question === 'X_FOLLOW_UP: shorter.')!.id;
    const was = targetOf(x)!;
    const now = retarget(child, { model: CLAUDE_CODE, effort: 'medium' });
    expect(now).toMatchObject({ model: CLAUDE_CODE, effort: 'medium', kind: 'agent', runtime: 'claude-code' });
    expect(now.targetId).not.toBe(was.targetId);
    expect(targetOf(x)).toEqual(was);
    const before = desktop.runs.length;
    await useStore.getState().regenerate(child);
    expect(desktop.runs[before]).toMatchObject({ runtime: 'claude-code', effort: 'medium' });
  });
});

describe('wiring material to a task', () => {
  const setup = async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A_ONLY_K7: trimmed mean.\n'), { x: 0, y: 0 });
    const c = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/c.md', 'SHARED_C_L5: the 2024 wave.\n'), { x: 300, y: 0 });
    const x = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 400 });
    const y = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 400 });
    return { a, c, x, y };
  };

  it('makes an edge and nothing else: no run starts, no file moves or changes, the material stays where it is', async () => {
    const { a, x } = await setup();
    const fileId = node(a).data.resourceRef!.fileId;
    const callsBefore = shell.calls.length;
    const placeBefore = { ...node(a).position };

    expect(connectNode(a, x)).toMatchObject({ ok: true });
    expect(edgesInto(x).map((e) => e.source)).toEqual([a]);
    expect(contextOf(x)).toContain('A_ONLY_K7');
    expect(desktop.runs, 'nothing was sent to any AI').toEqual([]);
    expect(node(x).data.isLoading).toBe(false);
    expect(shell.calls.slice(callsBefore).map((call) => call.method).filter((m) => ['moveFile', 'copyFile', 'trashFile', 'saveText', 'createFile', 'importText'].includes(m))).toEqual([]);
    expect(shell.files.get(fileId)).toMatchObject({ relativePath: 'notes/a.md', content: 'A_ONLY_K7: trimmed mean.\n', status: 'ready' });
    expect(node(a).position).toEqual(placeBefore);
    expect(node(a).data.resourceRef!.fileId).toBe(fileId);
  });

  it('a file dropped on a task by reference is wired the same way, through the node that already stands for it', async () => {
    const { a, x } = await setup();
    const ref = node(a).data.resourceRef!;
    const nodesBefore = useStore.getState().nodes.length;
    connectSelection(x, [ref]);
    expect(edgesInto(x).map((e) => e.source)).toEqual([a]);
    expect(useStore.getState().nodes.length, 'no second node for the same file').toBe(nodesBefore);
    expect(desktop.runs).toEqual([]);
    // dropping it again changes nothing
    connectSelection(x, [ref]);
    expect(edgesInto(x).length).toBe(1);
  });

  it('a file that has no node yet gets one, wired to the task it was dropped on and to no other', async () => {
    const { x, y } = await setup();
    shell.seed('notes/b.md', 'B_ONLY_Q9: robustness section.\n');
    const fileId = [...shell.files.values()].find((f) => f.relativePath === 'notes/b.md')!.fileId;
    connectSelection(y, [{ fileId, selector: { kind: 'document' }, version: { kind: 'live' }, payload: 'text' }]);
    await vi.waitFor(() => expect(contextOf(y)).toContain('B_ONLY_Q9'));
    expect(edgesInto(y).length).toBe(1);
    expect(contextOf(x)).not.toContain('B_ONLY_Q9');
    expect(desktop.runs).toEqual([]);
  });

  it('shared material is wired to each task by an edge of its own: taking one away leaves the other', async () => {
    const { a, c, x, y } = await setup();
    connectNode(a, x);
    const toX = connectNode(c, x);
    const toY = connectNode(c, y);
    if (!toX.ok || !toY.ok) throw new Error('the shared material was not wired');
    expect(toX.edgeId).not.toBe(toY.edgeId);
    expect(contextOf(x)).toContain('SHARED_C_L5');
    expect(contextOf(y)).toContain('SHARED_C_L5');

    useStore.getState().deleteEdges([toX.edgeId]);
    expect(useStore.getState().edges.some((e) => e.id === toY.edgeId), 'the other task still has it').toBe(true);
    expect(contextOf(x)).not.toContain('SHARED_C_L5');
    expect(contextOf(x), 'and what else was wired to this task is untouched').toContain('A_ONLY_K7');
    expect(contextOf(y)).toContain('SHARED_C_L5');
    expect(node(c), 'the material is still on the canvas').toBeDefined();

    const runY = await ask(y, 'Y_TASK: draft the reply.');
    const runX = await ask(x, 'X_TASK: write the paragraph.');
    expect(runY.prompt).toContain('SHARED_C_L5');
    expect(runY.prompt).not.toContain('A_ONLY_K7');
    expect(runX.prompt).toContain('A_ONLY_K7');
    expect(runX.prompt).not.toContain('SHARED_C_L5');
  });

  // Until T26b a connection that closed a loop was refused. The user chose (2026-10-14) to keep the
  // iteration a loop allows and make what each run reads fixed instead: the closing line is a feedback
  // line (tests/unit/feedback-lines.test.ts). Only a task wired into itself is still refused.
  it('makes a connection that would make what a task reads depend on its own answer a feedback line, and refuses a task into itself', async () => {
    const { x, y } = await setup();
    expect(connectNode(x, y)).toMatchObject({ ok: true });
    expect(wouldLoop(y, x)).toBe(true);
    const edgesBefore = useStore.getState().edges.length;
    expect(connectNode(y, x)).toMatchObject({ ok: true, feedback: true });
    expect(useStore.getState().edges.find((e) => e.source === y && e.target === x)!.data?.feedback).toBeDefined();
    expect(connectNode(x, x)).toEqual({ ok: false, reason: 'loop' });
    expect(useStore.getState().edges.length).toBe(edgesBefore + 1);
    // through a third task as well
    const z = newTask(createTarget(templateFor(CODEX)), { x: 300, y: 800 });
    expect(connectNode(y, z)).toMatchObject({ ok: true });
    expect(connectNode(z, x)).toMatchObject({ ok: true, feedback: true });
    // a feedback line carries no live answer: it is not a way round a loop for the next connection
    expect(wouldLoop(x, z)).toBe(false);
  });

  it('is only done into a node that asks: material is not wired into material', async () => {
    const { a, c } = await setup();
    expect(connectNode(a, c)).toEqual({ ok: false, reason: 'not-a-task' });
    expect(connectNode('no-such-node', a)).toEqual({ ok: false, reason: 'unknown' });
    expect(useStore.getState().edges).toEqual([]);
  });
});

describe('sending', () => {
  it('is not offered when there is no model to send to, and says which is missing', () => {
    useUiStore.getState().setSelectedModel(null);
    useStore.setState((st) => ({ nodes: [...st.nodes, { ...note('q1', ''), data: { ...note('q1', '').data, stepKind: undefined } }] }));
    expect(canSend('q1', { models: [], serverDefault: null })).toEqual({ ok: false, reason: 'no-model' });
    // with a default to fall back on, a task that has no target yet can be sent: it is bound to that when it runs
    expect(canSend('q1', { models: [], serverDefault: 'synthetic-provider/api-model' })).toEqual({ ok: true });
    useUiStore.getState().setSelectedModel(CODEX);
    expect(canSend('q1', { models: [], serverDefault: null })).toEqual({ ok: true });
  });

  it('is not offered for a task whose API model is not among the models that can be reached here', () => {
    const task = newTask(createTarget(templateFor(CLAUDE_API)), { x: 0, y: 0 });
    const reachable = (id: string) => ({ id, name: id, provider: id.split('/')[0], vision: false });
    expect(canSend(task, { models: [reachable(CLAUDE_API)], serverDefault: null })).toEqual({ ok: true });
    expect(canSend(task, { models: [reachable('other-provider/claude-sonnet')], serverDefault: 'other-provider/claude-sonnet' })).toEqual({ ok: false, reason: 'unavailable', model: CLAUDE_API });
    // nothing is known about what can be reached: the task is not held back on a guess
    expect(canSend(task, { models: [], serverDefault: null })).toEqual({ ok: true });
  });

  describe('for a task whose API model is known not to be reachable', () => {
    const reachable = { id: 'other-provider/claude-sonnet', name: 'claude-sonnet', provider: 'other-provider', vision: false };
    const asked: string[] = [];
    beforeEach(async () => {
      asked.length = 0;
      useUiStore.setState({ toasts: [] });
      vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
        if (init?.body) { try { const body = JSON.parse(init.body) as { model?: string }; if (body.model) asked.push(body.model); } catch { /* not a request for an answer */ } }
        throw new Error('no network in tests');
      });
      (await import('../../src/lib/use-models')).setModelsCache({ models: [reachable], default: reachable.id });
    });
    // nothing known about what can be reached, as in every other test here
    afterEach(async () => { (await import('../../src/lib/use-models')).setModelsCache({ models: [], default: null }); });

    it('typing its question sends nothing, to that model or to another provider\'s of the same name, and the person is told', async () => {
      const task = newTask(createTarget(templateFor(CLAUDE_API)), { x: 0, y: 0 });
      await useStore.getState().editQuestion(task, 'P_TASK: summarize.');
      expect(asked, 'no request for an answer went to any model').toEqual([]);
      expect(desktop.runs).toEqual([]);
      expect(node(task).data, 'the task is as it was: still waiting for its question').toMatchObject({ question: '', isLoading: false });
      expect(useUiStore.getState().toasts.map((toast) => toast.kind)).toEqual(['error']);
      expect(targetOf(task), 'and still bound to the AI the person chose').toMatchObject({ model: CLAUDE_API });
      // a question below it is not sent either
      const nodesBefore = useStore.getState().nodes.length;
      await useStore.getState().addQuestion('P_FOLLOW_UP', { parentId: task });
      expect(useStore.getState().nodes.length).toBe(nodesBefore);
      expect(asked).toEqual([]);
    });

    it('running it again does not fall back to another model: the run stops and the task says why', async () => {
      const task = newTask(createTarget(templateFor(CLAUDE_API)), { x: 0, y: 0 });
      // the task was asked while its model could still be reached
      useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === task ? { ...n, data: { ...n.data, question: 'P_TASK: summarize.', response: 'an earlier answer', responses: ['an earlier answer'], responseIndex: 0, generatedBy: [CLAUDE_API] } } : n)) }));
      await useStore.getState().regenerate(task);
      const again = useStore.getState().nodes.find((n) => n.id !== task)!;
      expect(asked).toEqual([]);
      expect(desktop.runs).toEqual([]);
      expect(again.data).toMatchObject({ isLoading: false, generationFailed: true });
      expect(again.data.response).toContain(CLAUDE_API);
      expect(again.data.generatedBy ?? [], 'nothing answered, so nothing is recorded as having answered').toEqual([]);
      expect(again.data.target).toMatchObject({ model: CLAUDE_API });
      expect(node(task).data.response, 'the earlier answer is untouched').toBe('an earlier answer');
    });
  });
});
