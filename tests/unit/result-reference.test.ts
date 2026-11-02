import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparePreparedRuns, referenceAnswer, answerVersionsOf } from '../../src/lib/agents/result-reference';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { asOfVersion, latestFinished, pinnedVersionOf } from '../../src/lib/feedback';
import { prepareTargetRun } from '../../src/lib/context/prepare-target-run';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { buildContext } from '../../src/store/context-builder';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What one AI is given of another's answer (T29), and only when the person says: the
// words of the one answer, whichever versions come after; versions keep their identity
// when others go (R4-10), a failure is a version's and not the node's (R4-11), and a
// sibling asked again does not go back and forth by itself (R4-12). On a stand-in for
// the model server.

const CANVAS = 'canvas-1';
const API_MODEL = 'synthetic-provider/model';
const OTHER = 'synthetic-provider/other';
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.split('/')[0], vision: false, tools: false, webSearch: false, scholarSearch: false });
let desktop: FakeDesktop;
let reply = 'AN_ANSWER';
let fails = false;
let bodies: { messages: { content: string }[]; model?: string }[] = [];
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const edgesOf = (target: string) => useStore.getState().edges.filter((e) => e.target === target);
const sentTo = (id: string) => buildContext(id, useStore.getState().nodes, useStore.getState().edges).messages.map((m) => m.content).join('\n');

function task(modelId: string, question: string) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 200 * useStore.getState().nodes.length });
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question } } : n)) }));
  return id;
}
/** The node answers, as a run does. */
async function answers(id: string, text: string) {
  reply = text;
  await useStore.getState().rerunNode(id, {});
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  bodies = [];
  fails = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json({ models: [model(API_MODEL), model(OTHER)], default: null });
    if (url.endsWith('/api/stream')) {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (fails) return new Response(`data: ${JSON.stringify({ error: 'IT_BROKE' })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(`data: ${JSON.stringify({ text: reply })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({});
  });
  desktop = installFakeDesktop();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false, webSearchEnabled: false });
  setModelsCache({ models: [model(API_MODEL), model(OTHER)], default: null });
  await recheckAgents();
  setModelsCache({ models: [model(API_MODEL), model(OTHER)], default: null });
  useUiStore.getState().setSelectedModel(API_MODEL);
});
afterEach(() => {
  desktop.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
});

describe('[T29] an answer has an identity of its own', () => {
  it('[T29] each answer gets one, and keeps it when another goes', async () => {
    const x = task(API_MODEL, 'X?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, response: 'seed', responses: ['seed'], questions: ['X?'] } } : n)) }));
    await useStore.getState().rerunNode(x, { }); // appended or replaced as a rerun does
    const ids = answerVersionsOf(node(x)).map((v) => v.answerVersionId);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('[T29] an answer from before these were kept still has one, that holds while its place holds', () => {
    const x = task(API_MODEL, 'X?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, response: 'old', responses: ['old'], generatedAts: ['2026-01-01T00:00:00Z'] } } : n)) }));
    expect(answerVersionsOf(node(x))[0].answerVersionId).toBeTruthy();
  });
});

const withVersions = (id: string, ...texts: string[]) => useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, response: texts.at(-1)!, responses: texts, responseIndex: texts.length - 1, questions: texts.map(() => n.data.question), answerIds: texts.map((_, i) => `ans_${i}`) } } : n)) }));

describe('[T29] an answer referred to', () => {
  it('[T29] answers on one canvas are not shared: nothing goes from one task to another until the person says', () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    withVersions(x, 'X_ANSWER_V1');
    expect(sentTo(y)).not.toContain('X_ANSWER_V1');
    expect(edgesOf(y)).toEqual([]);
  });

  it('[T29] referred to at one version, it stays that version when the source answers again, and the newer one is only said', async () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    withVersions(x, 'X_ANSWER_V1');
    referenceAnswer(y, x, 'ans_0', 'summary');
    expect(sentTo(y)).toContain('X_ANSWER_V1');
    withVersions(x, 'X_ANSWER_V1', 'X_ANSWER_V2');
    expect(sentTo(y)).toContain('X_ANSWER_V1');
    expect(sentTo(y)).not.toContain('X_ANSWER_V2');
    const edge = edgesOf(y)[0];
    expect(edge.data?.feedback?.versionId).toBe('ans_0');
    expect(latestFinished(node(x))).toBe(1);
    expect(pinnedVersionOf(node(x), edge.data!.feedback!)).toBe(0);
  });

  it('[T29] it does not move when the task asks again: it is what was referred to, not the latest', async () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    withVersions(x, 'X_ANSWER_V1', 'X_ANSWER_V2');
    referenceAnswer(y, x, 'ans_0', 'summary');
    useStore.getState().advanceFeedback(y);
    expect(edgesOf(y)[0].data?.feedback?.versionId).toBe('ans_0');
    expect(sentTo(y)).toContain('X_ANSWER_V1');
  });

  it('[T29] it carries the words of the answer: not the question\'s conversation, not its tools', () => {
    const up = task(API_MODEL, 'UPSTREAM_QUESTION?');
    withVersions(up, 'UPSTREAM_ANSWER');
    const x = task(API_MODEL, 'X?');
    useStore.setState((st) => ({ edges: [...st.edges, { id: 'chain', source: up, target: x }] }));
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, attachments: [{ id: 'tool-1', name: 'bash', type: 'text/plain', content: 'TOOL_OUTPUT_SECRET', op: 'exec' }] } } : n)) }) as never);
    withVersions(x, 'X_ANSWER_V1');
    const y = task(OTHER, 'Y?');
    referenceAnswer(y, x, 'ans_0', 'summary');
    const sent = sentTo(y);
    expect(sent).toContain('X_ANSWER_V1');
    expect(sent).not.toContain('UPSTREAM_ANSWER');
    expect(sent).not.toContain('TOOL_OUTPUT_SECRET');
  });

  it('[T29] at depth "path", what led up to the answer comes along', () => {
    const up = task(API_MODEL, 'UPSTREAM_QUESTION?');
    withVersions(up, 'UPSTREAM_ANSWER');
    const x = task(API_MODEL, 'X?');
    useStore.setState((st) => ({ edges: [...st.edges, { id: 'chain', source: up, target: x }] }));
    withVersions(x, 'X_ANSWER_V1');
    const y = task(OTHER, 'Y?');
    referenceAnswer(y, x, 'ans_0', 'path');
    expect(sentTo(y)).toContain('UPSTREAM_ANSWER');
    expect(sentTo(y)).toContain('X_ANSWER_V1');
  });

  it('[T29] at depth "selected", only what is marked in that answer comes', () => {
    const x = task(API_MODEL, 'X?');
    withVersions(x, 'KEEP_THIS part and DROP_THAT part');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, highlights: [{ id: 'h', text: 'KEEP_THIS part' }], highlightMode: 'tag' } } : n)) }) as never);
    const y = task(OTHER, 'Y?');
    referenceAnswer(y, x, 'ans_0', 'selected');
    expect(sentTo(y)).toContain('KEEP_THIS part');
    expect(sentTo(y)).not.toContain('DROP_THAT');
  });

  it('[T29] an answer that is not there, or a reference to itself, is refused', () => {
    const x = task(API_MODEL, 'X?');
    withVersions(x, 'V1');
    const y = task(OTHER, 'Y?');
    expect(() => referenceAnswer(y, x, 'ans_nope', 'summary')).toThrow();
    expect(() => referenceAnswer(x, x, 'ans_0', 'summary')).toThrow();
    expect(edgesOf(y)).toEqual([]);
  });

  it('[T29] referring to the same answer twice is one reference, at the depth last asked', () => {
    const x = task(API_MODEL, 'X?');
    withVersions(x, 'V1');
    const y = task(OTHER, 'Y?');
    referenceAnswer(y, x, 'ans_0', 'summary');
    referenceAnswer(y, x, 'ans_0', 'path');
    expect(edgesOf(y)).toHaveLength(1);
    expect(edgesOf(y)[0].data?.feedback?.depth).toBe('path');
  });
});

describe('[T29][R4-10] a version is what it was, whichever others go', () => {
  it('[R4-10] a feedback line holds its answer when an earlier one is deleted', () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    withVersions(x, 'V1', 'V2', 'V3');
    referenceAnswer(y, x, 'ans_1', 'summary');
    expect(sentTo(y)).toContain('V2');
    useStore.getState().deleteVersion(x, 0);
    expect(sentTo(y)).toContain('V2');
    expect(sentTo(y)).not.toContain('V3');
    expect(edgesOf(y)[0].data?.feedback?.version).toBe(0);
  });

  it('[R4-10] the answer itself deleted: it reads nothing rather than another answer', () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    withVersions(x, 'V1', 'V2');
    referenceAnswer(y, x, 'ans_0', 'summary');
    useStore.getState().deleteVersion(x, 0);
    expect(edgesOf(y)[0].data?.feedback?.version).toBeNull();
    expect(sentTo(y)).not.toContain('V2');
  });

  it('[R4-10] a line from before versions had names keeps to its place through a deletion too', () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, response: 'V3', responses: ['V1', 'V2', 'V3'], responseIndex: 2 } } : n)), edges: [...st.edges, { id: 'fb', source: x, target: y, data: { isCrossLink: true, feedback: { version: 1, pinnedAt: 'then' } } }] }));
    useStore.getState().deleteVersion(x, 0);
    expect(edgesOf(y)[0].data?.feedback?.version).toBe(0);
    expect(sentTo(y)).toContain('V2');
  });

  it('[R4-10] undoing a deletion puts the line back with the answer', () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    withVersions(x, 'V1', 'V2', 'V3');
    referenceAnswer(y, x, 'ans_1', 'summary');
    useStore.getState().pushHistory();
    useStore.getState().deleteVersion(x, 0);
    useStore.getState().undo();
    expect(edgesOf(y)[0].data?.feedback?.version).toBe(1);
    expect(sentTo(y)).toContain('V2');
  });
});

describe('[T29][R4-11] a failure is its version\'s', () => {
  it('[R4-11] looked away from and back: the failure is still not a finished answer', async () => {
    const x = task(API_MODEL, 'X?');
    await answers(x, 'A_REAL_ANSWER');
    fails = true;
    await useStore.getState().rerunNode(x, {});
    fails = false;
    expect(node(x).data.generationFailed).toBe(true);
    const failedAt = node(x).data.responses.length - 1;
    expect(latestFinished(node(x))).toBe(failedAt - 1);
    useStore.getState().navigateVersion(x, 'prev');
    expect(node(x).data.generationFailed).toBeFalsy();
    expect(latestFinished(node(x))).toBe(failedAt - 1);
    useStore.getState().navigateVersion(x, 'next');
    expect(node(x).data.generationFailed).toBe(true);
    expect(latestFinished(node(x))).toBe(failedAt - 1);
  });

  it('[R4-11] a failure is not offered to be referred to', async () => {
    const x = task(API_MODEL, 'X?');
    await answers(x, 'A_REAL_ANSWER');
    fails = true;
    await useStore.getState().rerunNode(x, {});
    fails = false;
    const versions = answerVersionsOf(node(x));
    expect(versions.map((v) => v.failed)).toEqual([false, true]);
    const y = task(OTHER, 'Y?');
    expect(() => referenceAnswer(y, x, versions[1].answerVersionId, 'summary')).toThrow();
  });
});

describe('[T29][R4-12] asked again beside', () => {
  it('[R4-12] the sibling reads what the original reads, and does not go back and forth by itself', async () => {
    const x = task(API_MODEL, 'X?');
    const y = task(OTHER, 'Y?');
    withVersions(x, 'X_V1');
    withVersions(y, 'Y_V1');
    useStore.setState((st) => ({ edges: [...st.edges, { id: 'fb', source: x, target: y, data: { isCrossLink: true, feedback: { version: 0, versionId: 'ans_0', pinnedAt: 'then', auto: 3 } } }] }));
    await useStore.getState().regenerate(y);
    const sibling = useStore.getState().nodes.find((n) => n.id !== x && n.id !== y)!;
    const line = edgesOf(sibling.id).find((e) => e.source === x)!;
    expect(line.data?.feedback?.version).toBe(0);
    expect(line.data?.feedback?.auto ?? 0).toBe(0);
    expect(edgesOf(y)[0].data?.feedback?.auto).toBe(3);
  });
});

describe('[T29] comparing what two runs would be given', () => {
  it('[T29] one material to two tasks is two envelopes, and what differs is said', async () => {
    const x = task(API_MODEL, 'Same?');
    const y = task(OTHER, 'Same?');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, attachments: [{ id: 'a', name: 'only-x.txt', type: 'text/plain', content: 'ONLY_X', extractedText: 'ONLY_X' }] } } : n)) }) as never);
    const runs = [await prepareTargetRun(CANVAS, x, node(x).data.target!.revision), await prepareTargetRun(CANVAS, y, node(y).data.target!.revision)];
    expect(runs[0].envelope.runId).not.toBe(runs[1].envelope.runId);
    const differences = comparePreparedRuns(runs);
    expect(differences).toHaveLength(2);
    const [dx, dy] = differences;
    expect(dx.targetId).toBe(runs[0].target.targetId);
    expect(dx.added).toEqual(runs[0].envelope.inputs.map((i) => i.inputId));
    expect(dx.missing).toEqual([]);
    expect(dy.added).toEqual([]);
    expect(dy.missing).toEqual(dx.added);
    expect(dx.model).toBe(API_MODEL);
    expect(dy.model).toBe(OTHER);
  });

  it('[T29] two runs given the same: nothing differs', async () => {
    const x = task(API_MODEL, 'Same?');
    const y = task(OTHER, 'Same?');
    const runs = [await prepareTargetRun(CANVAS, x, node(x).data.target!.revision), await prepareTargetRun(CANVAS, y, node(y).data.target!.revision)];
    for (const d of comparePreparedRuns(runs)) { expect(d.added).toEqual([]); expect(d.missing).toEqual([]); }
  });

  it('[T29] preparing to compare sends nothing', async () => {
    const x = task(API_MODEL, 'Same?');
    await prepareTargetRun(CANVAS, x, node(x).data.target!.revision);
    expect(bodies).toEqual([]);
    expect(desktop.runs).toEqual([]);
  });

  it('[T29] however much a run is given, nothing of it is cut without saying', async () => {
    const x = task(API_MODEL, 'Big?');
    const huge = 'word '.repeat(400_000);
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === x ? { ...n, data: { ...n.data, attachments: [{ id: 'a', name: 'huge.txt', type: 'text/plain', content: huge, extractedText: huge }] } } : n)) }) as never);
    const { envelope } = await prepareTargetRun(CANVAS, x, node(x).data.target!.revision);
    expect(JSON.stringify(envelope.messages).length).toBeGreaterThan(huge.length);
  });

  it('[T29] an older answer as it was: asOfVersion shows that version', () => {
    const x = task(API_MODEL, 'X?');
    withVersions(x, 'V1', 'V2');
    expect(asOfVersion(node(x), 0).data.response).toBe('V1');
  });
});
