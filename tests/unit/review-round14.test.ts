import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerVersionsOf, comparePreparedRuns, referenceAnswer } from '../../src/lib/agents/result-reference';
import { createTarget, newTask, setRunMode, templateFor } from '../../src/lib/agents/targets';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { buildContext } from '../../src/store/context-builder';
import { bootProjects, useProjects } from '../../src/store/projects';
import { noteCapabilities } from '../../src/lib/context/policy';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What the review of T15..T29 found on the page (R14-01, R14-03, R14-04). On stand-ins for the
// shell and the model server.

const CANVAS = 'c';
const CODEX = 'codex/gpt-synthetic';
const API = 'synthetic-provider/model';
const model = (id: string) => ({ id, name: id, provider: id.startsWith('codex/') ? '__agent__' : 'synthetic-provider', vision: false });
let desktop: FakeDesktop;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const sentTo = (id: string) => buildContext(id, useStore.getState().nodes, useStore.getState().edges).messages.map((m) => m.content).join('\n');
const edgeInto = (id: string) => useStore.getState().edges.find((e) => e.target === id)!;
function task(modelId: string, question: string, data = {}) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 200 * useStore.getState().nodes.length });
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, ...data } } : n)) }));
  return id;
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  desktop = installFakeDesktop({ hold: true });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'c', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false });
  setModelsCache({ models: [model(CODEX), model(API)], default: null } as never);
  await recheckAgents();
  setModelsCache({ models: [model(CODEX), model(API)], default: null } as never);
  useUiStore.getState().setSelectedModel(CODEX);
});
afterEach(() => {
  desktop.uninstall();
  vi.unstubAllGlobals();
  noteCapabilities('codex', null);
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

describe('[R14-01] what a run is for is what it was prepared as', () => {
  /** A run stopped where it waits for its materials, while `change` is done to the task. */
  async function changedWhileMaterials(data: object, change: (id: string) => void) {
    const bridge = window.desktopAgents!;
    const real = bridge.materialize!;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached: () => void = () => {};
    const atMaterials = new Promise<void>((resolve) => { reached = resolve; });
    bridge.materialize = async (...args) => { reached(); await held; return real(...args); };
    const id = task(CODEX, 'Do it?', data);
    const prepared = node(id).data.target!;
    const running = useStore.getState().rerunNode(id, {});
    await atMaterials;
    change(id);
    release();
    await vi.waitFor(() => expect(desktop.runs).toHaveLength(1));
    desktop.end(desktop.runIds[0], 'done');
    await running;
    return { id, prepared, sent: desktop.runs[0] };
  }
  const attachment = { attachments: [{ id: 'a', name: 'in.txt', type: 'text/plain', content: 'IN', extractedText: 'IN' }] };

  it('[R14-01] set to research while it waits for its materials: it goes as what it was, a writer, for the target it was', async () => {
    const { prepared, sent, id } = await changedWhileMaterials(attachment, (t) => { setRunMode(t, 'research'); });
    expect(sent.mode).toBeUndefined();
    expect(sent.target).toEqual({ targetId: prepared.targetId, writes: true });
    expect(node(id).data.target!.targetId).not.toBe(prepared.targetId);
  });

  it('[R14-01] the other way: prepared as research, set to work meanwhile: it goes as research, reading only', async () => {
    noteCapabilities('codex', { runtime: 'codex', binaryVersion: 'x', probedAt: 'now', capabilities: { fresh: 'supported', resume: 'supported', forkAtCompletedTurn: 'supported', observeState: 'supported', cancel: 'supported', approvals: 'supported', readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'supported' } });
    const bridge = window.desktopAgents!;
    const real = bridge.materialize!;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reached: () => void = () => {};
    const atMaterials = new Promise<void>((resolve) => { reached = resolve; });
    bridge.materialize = async (...args) => { reached(); await held; return real(...args); };
    const id = task(CODEX, 'Do it?', attachment);
    const prepared = setRunMode(id, 'research');
    const running = useStore.getState().rerunNode(id, {});
    await atMaterials;
    setRunMode(id, 'workspace');
    release();
    await vi.waitFor(() => expect(desktop.runs).toHaveLength(1));
    expect(desktop.runs[0].mode).toBe('research');
    expect(desktop.runs[0].target).toEqual({ targetId: prepared.targetId, writes: false });
    desktop.end(desktop.runIds[0], 'done');
    await running;
  });

  it('[R14-01] the task removed while it waits: it goes as what it was, or not at all, and never as nobody', async () => {
    const { sent, prepared } = await changedWhileMaterials(attachment, (t) => { useStore.setState((st) => ({ nodes: st.nodes.filter((n) => n.id !== t) })); }).catch(() => ({ sent: null, prepared: null }));
    if (sent) expect(sent.target?.targetId).toBe(prepared!.targetId);
  });
});

const legacy = (id: string, texts: string[], more = {}) => useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, response: texts.at(-1)!, responses: texts, responseIndex: texts.length - 1, answerIds: undefined, generatedAts: undefined, ...more } } : n)) }));

describe('[R14-03] an answer from before answers had names', () => {
  for (const [what, more] of [
    ['no dates', {}],
    ['the same date twice', { generatedAts: ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'] }],
    ['some with names and some without', { answerIds: ['ans_kept', undefined, undefined] }],
  ] as [string, object][]) {
    it(`[R14-03] ${what}: referred to, it stays that answer when an earlier one is deleted`, () => {
      const x = task(API, 'X?');
      const y = task(API, 'Y?');
      legacy(x, ['ANSWER_A', 'ANSWER_B', 'ANSWER_C'], more);
      referenceAnswer(y, x, answerVersionsOf(node(x))[1].answerVersionId, 'summary');
      expect(sentTo(y)).toContain('ANSWER_B');
      useStore.getState().deleteVersion(x, 0);
      expect(sentTo(y)).toContain('ANSWER_B');
      expect(sentTo(y)).not.toContain('ANSWER_C');
      expect(edgeInto(y).data?.feedback?.versionId).toMatch(/^ans_/);
    });
  }

  it('[R14-03] the names it is given stay with the answers: asked for again, they are the same', () => {
    const x = task(API, 'X?');
    const y = task(API, 'Y?');
    legacy(x, ['ANSWER_A', 'ANSWER_B']);
    referenceAnswer(y, x, answerVersionsOf(node(x))[0].answerVersionId, 'summary');
    const ids = node(x).data.answerIds!;
    expect(ids.every((id) => id?.startsWith('ans_'))).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(answerVersionsOf(node(x)).map((v) => v.answerVersionId)).toEqual(ids);
  });

  it('[R14-03] a line saved with a name made from a place goes by its place, and keeps to it through a deletion', () => {
    const x = task(API, 'X?');
    const y = task(API, 'Y?');
    legacy(x, ['ANSWER_A', 'ANSWER_B', 'ANSWER_C']);
    useStore.setState((st) => ({ edges: [...st.edges, { id: 'old', source: x, target: y, data: { isCrossLink: true, feedback: { version: 1, versionId: 'legacy:1', pinnedAt: 'then', fixed: true } } }] }));
    useStore.getState().deleteVersion(x, 0);
    expect(sentTo(y)).toContain('ANSWER_B');
    expect(sentTo(y)).not.toContain('ANSWER_C');
  });

  it('[R14-03] a feedback line to an old answer does not take a name from its place', () => {
    const x = task(API, 'X?');
    const y = task(API, 'Y?');
    legacy(x, ['ANSWER_A', 'ANSWER_B']);
    useStore.getState().addFeedbackLink(x, y);
    expect(edgeInto(y).data?.feedback?.versionId ?? null).toBeNull();
    useStore.getState().deleteVersion(x, 0);
    expect(sentTo(y)).toContain('ANSWER_B');
  });

  it('[R14-03] undone, the deletion is as if it never was', () => {
    const x = task(API, 'X?');
    const y = task(API, 'Y?');
    legacy(x, ['ANSWER_A', 'ANSWER_B', 'ANSWER_C']);
    referenceAnswer(y, x, answerVersionsOf(node(x))[1].answerVersionId, 'summary');
    useStore.getState().deleteVersion(x, 0);
    useStore.getState().undo();
    expect(sentTo(y)).toContain('ANSWER_B');
    expect(node(x).data.responses).toHaveLength(3);
  });
});

describe('[R14-04] what differs between runs is what they are given', () => {
  const HASH = `sha256:${'a'.repeat(64)}`;
  const passage = (inputId: string, quote: string) => ({ inputId, displayName: 'paper.md', contentHash: HASH, snapshotId: `snap_${'a'.repeat(64)}`, payload: 'text', reason: 'wired', size: { bytes: 1 }, source: { kind: 'resource', ref: { fileId: 'f', selector: { kind: 'text', quote, prefix: '', suffix: '' }, version: { kind: 'snapshot', snapshotId: 's' }, payload: 'text' } } });
  const whole = (inputId: string) => ({ ...passage(inputId, ''), source: { kind: 'resource', ref: { fileId: 'f', selector: { kind: 'document' }, version: { kind: 'snapshot', snapshotId: 's' }, payload: 'text' } } });
  const run = (targetId: string, ...inputs: unknown[]) => ({ target: { targetId, label: targetId } as never, envelope: { inputs, runtime: { model: 'm', effort: null }, policy: { tools: { allow: [] } } } as never });

  it('[R14-04] two passages of one file are two inputs', () => {
    const [a, b] = comparePreparedRuns([run('x', passage('in_a', 'ALPHA')), run('y', passage('in_b', 'BETA'))]);
    expect(a.added).toEqual(['in_a']);
    expect(a.missing).toEqual(['in_b']);
    expect(b.added).toEqual(['in_b']);
    expect(b.missing).toEqual(['in_a']);
  });
  it('[R14-04] the whole file and a passage of it are two inputs', () => {
    const [a] = comparePreparedRuns([run('x', whole('in_w')), run('y', passage('in_p', 'ALPHA'))]);
    expect(a.added).toEqual(['in_w']);
    expect(a.missing).toEqual(['in_p']);
  });
  it('[R14-04] several passages of one file on one run are all there', () => {
    const [a] = comparePreparedRuns([run('x', passage('in_a', 'ALPHA'), passage('in_b', 'BETA')), run('y')]);
    expect(a.added).toEqual(['in_a', 'in_b']);
  });
  it('[R14-04] control: one passage on both, whatever it is called on each: nothing differs', () => {
    for (const d of comparePreparedRuns([run('x', passage('in_a', 'ALPHA')), run('y', passage('in_c', 'ALPHA'))])) {
      expect(d.added).toEqual([]);
      expect(d.missing).toEqual([]);
    }
  });
  it('[R14-04] control: one file whole on both: nothing differs', () => {
    for (const d of comparePreparedRuns([run('x', whole('in_a')), run('y', whole('in_b'))])) expect(d.added).toEqual([]);
  });
});
