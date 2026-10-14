import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectNode, createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { buildContext, upstreamFingerprint } from '../../src/store/context-builder';
import { bootProjects, useProjects } from '../../src/store/projects';
import { autoLayout } from '../../src/lib/layout';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// Two tasks that read each other: a writer whose draft a critic reads, and
// the critic's critique read back by the writer. The line that closes the
// loop is a feedback line: it holds one finished answer of the other task,
// so what each run reads is fixed when it starts. The other task answering
// again does not make this one stale and does not run it; this one running
// is a new round, and the line moves to the other's latest finished answer
// then, and the run says which one it read.

const CODEX = 'codex/gpt-synthetic';
const CLAUDE_CODE = 'claude/claude-code/sonnet';
const CANVAS = 'canvas-1';
const model = (id: string, more: Record<string, unknown> = {}) => ({ id, name: id.split('/').pop()!, provider: '__agent__', vision: false, ...more });

let desktop: FakeDesktop;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const edgeOf = (source: string, target: string) => useStore.getState().edges.find((e) => e.source === source && e.target === target);
const contextOf = (id: string) => buildContext(id, useStore.getState().nodes, useStore.getState().edges).messages.map((m) => m.content).join('\n');
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const settle = async () => { for (let i = 0; i < 20; i++) await settled(); };

/** A task with a question and the answers it has given, oldest first; its answer is recorded as written against its upstream as it is now. */
function answered(id: string, question: string, answers: string[]) {
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? {
      ...n,
      data: {
        ...n.data, question, questions: answers.map(() => question), responses: answers, response: answers.at(-1) ?? '', responseIndex: answers.length - 1,
        generatedBy: answers.map(() => n.data.target?.model ?? CODEX), isLoading: false, generationFailed: undefined,
      },
    } : n)),
  }));
  const { nodes, edges } = useStore.getState();
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, lastContextHash: upstreamFingerprint(id, nodes, edges) } } : n)) }));
}
/** The other task answers again. */
const answersAgain = (id: string, text: string) => answered(id, node(id).data.question, [...node(id).data.responses, text]);

/** A writer and a critic: the critic reads the writer's draft; the writer is to read the critique. */
function writerAndCritic() {
  const writer = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
  const critic = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 0 });
  answered(writer, 'W_TASK: write the paragraph.', ['W_DRAFT_1']);
  answered(critic, 'C_TASK: criticise the paragraph.', ['C_CRITIQUE_1']);
  expect(connectNode(writer, critic).ok).toBe(true);
  return { writer, critic };
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop();
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {} });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [] });
  useUiStore.getState().setSelectedModel(CODEX);
  setModelsCache({ models: [model(CODEX, { efforts: ['low', 'medium', 'high'] }), model(CLAUDE_CODE)], default: null });
  await recheckAgents();
  setModelsCache({ models: [model(CODEX, { efforts: ['low', 'medium', 'high'] }), model(CLAUDE_CODE)], default: null });
});
afterEach(() => {
  desktop.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

describe('a connection that closes a loop', () => {
  it('[T26b] is made, as a feedback line that holds the answer the other task has now', () => {
    const { writer, critic } = writerAndCritic();
    const made = connectNode(critic, writer);
    expect(made.ok, 'it is not refused').toBe(true);
    const line = edgeOf(critic, writer)!;
    expect(line.data).toMatchObject({ isCrossLink: true, feedback: { version: 0 } });
    expect(edgeOf(writer, critic)!.data?.feedback, 'the line that was there is as it was').toBeUndefined();
  });

  it('[T26b] drawn by hand on the canvas, it is a feedback line too', () => {
    const { writer, critic } = writerAndCritic();
    useStore.getState().addCrossLink(critic, writer);
    expect(edgeOf(critic, writer)!.data).toMatchObject({ isCrossLink: true, feedback: { version: 0 } });
  });

  it('[T26b] into a task with no finished answer yet holds nothing until there is one', () => {
    const writer = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    const critic = newTask(createTarget(templateFor(CLAUDE_CODE)), { x: 600, y: 0 });
    answered(writer, 'W_TASK: write the paragraph.', ['W_DRAFT_1']);
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === critic ? { ...n, data: { ...n.data, question: 'C_TASK: criticise.' } } : n)) }));
    connectNode(writer, critic);
    expect(connectNode(critic, writer).ok).toBe(true);
    expect(edgeOf(critic, writer)!.data?.feedback).toMatchObject({ version: null });
  });

  it('[T26b] from a task into itself is still refused', () => {
    const writer = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 0 });
    expect(connectNode(writer, writer)).toEqual({ ok: false, reason: 'loop' });
    expect(useStore.getState().edges).toEqual([]);
  });
});

describe('a feedback line', () => {
  it('[T26b] gives the task the answer it holds, whatever the other task answers later, and that answer does not make the task stale', () => {
    const { writer, critic } = writerAndCritic();
    connectNode(critic, writer);
    answered(writer, 'W_TASK: write the paragraph.', ['W_DRAFT_1']); // the writer's answer, written against the critique the line holds
    expect(contextOf(writer)).toContain('C_CRITIQUE_1');
    answersAgain(critic, 'C_CRITIQUE_2');
    expect(contextOf(writer)).toContain('C_CRITIQUE_1');
    expect(contextOf(writer), 'the newer critique is not read until the writer runs again').not.toContain('C_CRITIQUE_2');
    useStore.getState().recomputeStaleness();
    expect(useStore.getState().staleIds).not.toContain(writer);
  });

  it('[T26b] does not run the task when the other task answers, even a task set to run again by itself', async () => {
    const { writer, critic } = writerAndCritic();
    useStore.getState().addCrossLink(critic, writer); // drawn by hand: upstream ran such a loop round by itself
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === writer ? { ...n, data: { ...n.data, autoRerun: true, autoRerunRounds: 3 } } : n)) }));
    await useStore.getState().rerunNode(critic);
    await settle();
    expect(desktop.runs.map((r) => r.runtime), 'only the critic ran').toEqual(['claude-code']);
  });

  it('[T26b] moves, when the task runs, to the other task\'s latest finished answer: that is what is sent, and the run says which it read', async () => {
    const { writer, critic } = writerAndCritic();
    useStore.getState().addCrossLink(critic, writer);
    answersAgain(critic, 'C_CRITIQUE_2');
    await useStore.getState().rerunNode(writer);
    await settle();
    const sent = desktop.runs.at(-1)!;
    expect(sent.runtime).toBe('codex');
    expect(sent.prompt).toContain('C_CRITIQUE_2');
    expect(sent.prompt).not.toContain('C_CRITIQUE_1');
    const line = edgeOf(critic, writer)!;
    expect(line.data?.feedback).toMatchObject({ version: 1 });
    expect(node(writer).data.lastFeedback).toEqual({ [line.id]: { source: critic, version: 1 } });
    // and its new answer is the one written against what it reads now: it is not stale
    useStore.getState().recomputeStaleness();
    expect(useStore.getState().staleIds).not.toContain(writer);
  });

  it('[T26b] a question asked below the task starts a round too', async () => {
    const { writer, critic } = writerAndCritic();
    connectNode(critic, writer);
    answersAgain(critic, 'C_CRITIQUE_2');
    await useStore.getState().addQuestion('W_FOLLOW_UP: shorter.', { parentId: writer });
    await settle();
    expect(desktop.runs.at(-1)!.prompt).toContain('C_CRITIQUE_2');
    expect(edgeOf(critic, writer)!.data?.feedback).toMatchObject({ version: 1 });
  });

  it('[T26b] does not move to an answer still being written, or one that failed', async () => {
    const { writer, critic } = writerAndCritic();
    useStore.getState().addCrossLink(critic, writer);
    // the critic's last version failed
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === critic ? { ...n, data: { ...n.data, responses: ['C_CRITIQUE_1', 'C_FAILED_PLACEHOLDER'], response: 'C_FAILED_PLACEHOLDER', responseIndex: 1, generationFailed: true } } : n)) }));
    await useStore.getState().rerunNode(writer);
    await settle();
    expect(edgeOf(critic, writer)!.data?.feedback).toMatchObject({ version: 0 });
    expect(desktop.runs.at(-1)!.prompt).toContain('C_CRITIQUE_1');
    expect(desktop.runs.at(-1)!.prompt).not.toContain('C_FAILED_PLACEHOLDER');
    // the critic is answering again right now: what it has so far is not finished
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === critic ? { ...n, data: { ...n.data, responses: ['C_CRITIQUE_1'], response: 'C_HALF_WRITTEN', responseIndex: 0, generationFailed: undefined, isLoading: true } } : n)) }));
    await useStore.getState().rerunNode(writer);
    await settle();
    expect(edgeOf(critic, writer)!.data?.feedback).toMatchObject({ version: 0 });
    expect(desktop.runs.at(-1)!.prompt).not.toContain('C_HALF_WRITTEN');
  });

  it('[T26b] is not a way the layout goes: the canvas is laid out as if the line that runs back were not there', () => {
    const { writer, critic } = writerAndCritic();
    connectNode(critic, writer);
    const { nodes, edges } = useStore.getState();
    const positions = (laid: typeof nodes) => Object.fromEntries(laid.map((n) => [n.id, n.position]));
    const withLine = positions(autoLayout(structuredClone(nodes), edges));
    const withoutLine = positions(autoLayout(structuredClone(nodes), edges.filter((e) => !e.data?.feedback)));
    expect(withLine).toEqual(withoutLine);
    expect(withLine[critic].y, 'the critic stays below the writer whose draft it reads').toBeGreaterThan(withLine[writer].y);
  });

  it('[T26b] cannot be made solid: that would close the loop for real', () => {
    const { writer, critic } = writerAndCritic();
    useStore.getState().addCrossLink(critic, writer);
    const line = edgeOf(critic, writer)!;
    useStore.getState().setEdgeStructural(line.id, true);
    expect(edgeOf(critic, writer)!.data).toMatchObject({ isCrossLink: true, feedback: { version: 0 } });
  });
});
