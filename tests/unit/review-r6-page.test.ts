import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, newTask, setRunMode, templateFor } from '../../src/lib/agents/targets';
import { detectStale } from '../../src/lib/context/staleness';
import { planReplay, runReplay } from '../../src/lib/context/replay-plan';
import { documents } from '../../src/lib/documents/document-service';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { subscribeWorkspace } from '../../src/lib/workspace/events';
import { applyWorkspaceEvent, attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { activeAbortControllers } from '../../src/store/streaming';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// What the review of runs found on the page's side (its R6 numbers are kept in
// the test names): a replay counted a step as run when the promise of it
// settled, whether or not it wrote an answer, and went on to what read it; it
// looked at whether a step may write files only when it was planned; and after
// the newest answer was deleted, the answer back on show was judged by the run
// of the one that was deleted. On stand-ins for the desktop shell and the
// model, with synthetic canvases.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
const OTHER_MODEL = 'synthetic-provider/other';
let shell: FakeWorkspace;
let desktop: FakeDesktop;
let stop: (() => void) | null = null;
let streamed: string[] = [];
let respond: (body: { messages: { content: string }[] }) => Response | Promise<Response> = () => answer('ANSWER');
const answer = (text: string) => new Response(`data: ${JSON.stringify({ text })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false });
const MODELS = () => ({ models: [model(CODEX), model(API_MODEL), model(OTHER_MODEL)], default: null });
const patch = (id: string, data: Partial<ThoughtNode['data']>) => useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)) }));

function task(modelId: string, question: string, ...from: string[]) {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 + 200 * useStore.getState().nodes.length });
  useStore.setState((st) => ({
    nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question } } : n)),
    edges: [...st.edges, ...from.map((m) => ({ id: `edge-${m}-${id}`, source: m, target: id }))],
  }));
  return id;
}
const run = (id: string) => useStore.getState().rerunNode(id);

beforeAll(() => bootProjects());
beforeEach(async () => {
  streamed = [];
  respond = () => answer(`ANSWER_${streamed.length}`);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) {
      const body = JSON.parse(String(init?.body));
      streamed.push(body.messages.at(-1).content);
      return respond(body);
    }
    return Response.json({});
  });
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {} });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false, autoRefreshPaused: true });
  setModelsCache(MODELS());
  await recheckAgents();
  setModelsCache(MODELS());
  stop = await subscribeWorkspace('ws_1', applyWorkspaceEvent);
});
afterEach(async () => {
  stop?.();
  stop = null;
  await documents.dispose();
  desktop.uninstall();
  shell.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {} });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.setState({ autoRefreshPaused: false });
});

/** A → B, and an aside no step reads; all with an answer already, and the file A reads taken from under it when `file` is. */
async function chain() {
  const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A1\n'), { x: 0, y: 0 });
  const a = task(API_MODEL, 'question a', m);
  const b = task(API_MODEL, 'question b', a);
  const aside = task(API_MODEL, 'question aside');
  for (const id of [a, b, aside]) await run(id);
  streamed = [];
  return { m, a, b, aside };
}
const asks = () => streamed;

describe('[R6-04] a step that wrote no answer does not count as run', () => {
  it('[R6-04] control: a step that answers lets the next one go', async () => {
    const { a, b } = await chain();
    const outcome = await runReplay(planReplay([a], 'downstream'));
    expect(outcome.ran).toEqual([a, b]);
    expect(asks()).toEqual(['question a', 'question b']);
  });

  it('[R6-04] the file it reads is lost: what reads it is not run, and neither is said to have run', async () => {
    const { a, b } = await chain();
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'missing';
    const before = node(b).data.responses.length;
    const outcome = await runReplay(planReplay([a], 'downstream'));
    expect(outcome.ran).toEqual([]);
    expect(asks()).toEqual([]);
    expect(outcome.waiting).toEqual([b]);
    expect(outcome.failed).toEqual([{ nodeId: a, status: 'not-sent' }]);
    expect(node(b).data.responses.length).toBe(before);
  });

  it('[R6-04] the model answers with an error: what reads it is not run', async () => {
    const { a, b } = await chain();
    respond = () => new Response('upstream failure', { status: 500 });
    const outcome = await runReplay(planReplay([a], 'downstream'));
    expect(outcome.ran).toEqual([]);
    expect(outcome.failed).toEqual([{ nodeId: a, status: 'failed' }]);
    expect(outcome.waiting).toEqual([b]);
    expect(asks()).toEqual(['question a']);
  });

  it('[R6-04] the model says nothing: what reads it is not run', async () => {
    const { a, b } = await chain();
    respond = () => answer('');
    const outcome = await runReplay(planReplay([a], 'downstream'));
    expect(outcome.failed).toEqual([{ nodeId: a, status: 'failed' }]);
    expect(outcome.waiting).toEqual([b]);
  });

  it('[R6-04] the person stops it: what reads it is not run, and what was written so far stays', async () => {
    const { a, b } = await chain();
    let aborted = () => {};
    respond = () => new Promise<Response>((_resolve, reject) => { aborted = () => reject(new DOMException('stopped', 'AbortError')); });
    const replay = runReplay(planReplay([a], 'downstream'));
    await vi.waitFor(() => expect(asks()).toEqual(['question a']));
    activeAbortControllers.get(a)?.abort();
    aborted();
    const outcome = await replay;
    expect(outcome.ran).toEqual([]);
    expect(outcome.failed).toEqual([{ nodeId: a, status: 'cancelled' }]);
    expect(outcome.waiting).toEqual([b]);
  });

  it('[R6-04] it is already running: it is not a new answer, and what reads it is not run', async () => {
    const { a, b } = await chain();
    patch(a, { isLoading: true });
    const outcome = await runReplay(planReplay([a], 'downstream'));
    expect(outcome.ran).toEqual([]);
    expect(outcome.failed).toEqual([{ nodeId: a, status: 'busy' }]);
    expect(outcome.waiting).toEqual([b]);
    expect(asks()).toEqual([]);
  });

  it('[R6-04] it was deleted after the plan was made: what reads it is not run', async () => {
    const { a, b } = await chain();
    const plan = planReplay([a], 'downstream');
    useStore.setState((st) => ({ nodes: st.nodes.filter((n) => n.id !== a) }));
    const outcome = await runReplay(plan);
    expect(outcome.ran).toEqual([]);
    expect(outcome.waiting).toEqual(expect.arrayContaining([a, b]));
    expect(asks()).toEqual([]);
  });

  it('[R6-04] a branch that reads nothing that failed goes on', async () => {
    const { a, b, aside } = await chain();
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'missing';
    const outcome = await runReplay(planReplay([a, aside], 'downstream'));
    expect(outcome.ran).toEqual([aside]);
    expect(outcome.waiting).toEqual([b]);
    expect(outcome.failed).toEqual([{ nodeId: a, status: 'not-sent' }]);
  });

  it('[R6-04] the rerun itself says how it went', async () => {
    const { a, aside } = await chain();
    await expect(run(aside)).resolves.toEqual({ status: 'answered', versionIndex: 1 });
    shell.files.get(fileIdOf('notes/a.md'))!.status = 'missing';
    await expect(run(a)).resolves.toEqual({ status: 'not-sent' });
    await expect(run('nobody')).resolves.toEqual({ status: 'gone' });
  });
});

/** A → B, where finding A's answer changes B as the person might have while waiting. */
async function changedWhileWaiting(change: (b: string) => void, firstModel = API_MODEL) {
  const a = task(firstModel, 'question a');
  const b = task(API_MODEL, 'question b', a);
  const c = task(API_MODEL, 'question c', b);
  await run(a);
  await run(b);
  await run(c);
  streamed = [];
  const plan = planReplay([a], 'downstream');
  expect(plan.steps.map((s) => s.action)).toEqual(['rerun', 'rerun', 'rerun']);
  respond = () => { if (streamed.at(-1) === 'question a') change(b); return answer('ANSWER'); };
  const outcome = await runReplay(plan);
  return { a, b, c, outcome };
}

describe('[R6-05] whether a step may run is looked at again when it starts', () => {
  const bindTo = (b: string, modelId: string) => patch(b, { target: createTarget(templateFor(modelId)), model: modelId });

  it('[R6-05] control: nothing changed, every step runs', async () => {
    const { a, b, c, outcome } = await changedWhileWaiting(() => {});
    expect(outcome.ran).toEqual([a, b, c]);
    expect(outcome.waiting).toEqual([]);
    expect(desktop.runs).toEqual([]);
  });

  it('[R6-05] switched to an agent that may write files while it waited: it and what reads it wait for the person', async () => {
    const { a, b, c, outcome } = await changedWhileWaiting((id) => bindTo(id, CODEX));
    expect(outcome.ran).toEqual([a]);
    expect(outcome.waiting).toEqual([b, c]);
    expect(desktop.runs).toEqual([]);
  });

  it('[R6-05] an agent set from research to work while it waited does not start, nor what reads it', async () => {
    const a = task(API_MODEL, 'question a');
    const b = task(CODEX, 'question b', a);
    await run(a);
    setRunMode(b, 'research');
    patch(b, { response: 'OLD', responses: ['OLD'], responseIndex: 0 });
    const c = task(API_MODEL, 'question c', b);
    await run(c);
    streamed = [];
    const plan = planReplay([a], 'downstream');
    expect(plan.steps.find((s) => s.nodeId === b)!.action).toBe('rerun');
    respond = () => { if (streamed.at(-1) === 'question a') setRunMode(b, 'workspace'); return answer('ANSWER'); };
    const outcome = await runReplay(plan);
    expect(outcome.ran).toEqual([a]);
    expect(outcome.waiting).toEqual([b, c]);
    expect(desktop.runs).toEqual([]);
  });

  it('[R6-05] pointed at another AI while it waited: the plan was not made for that, so it waits', async () => {
    const { a, b, c, outcome } = await changedWhileWaiting((id) => bindTo(id, OTHER_MODEL));
    expect(outcome.ran).toEqual([a]);
    expect(outcome.waiting).toEqual([b, c]);
  });

  it('[R6-05] set to write files in the time its files are being frozen: it does not start', async () => {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A1\n'), { x: 0, y: 0 });
    const b = task(API_MODEL, 'question b', m);
    await run(b);
    const plan = planReplay([b], 'target-only');
    streamed = [];
    const held = shell.holdNext('freezeFile');
    const replay = runReplay(plan);
    await vi.waitFor(() => expect(shell.calls.some((c) => c.method === 'freezeFile')).toBe(true));
    bindTo(b, CODEX);
    held.release();
    const outcome = await replay;
    expect(outcome.ran).toEqual([]);
    expect(outcome.waiting).toEqual([b]);
    expect(asks()).toEqual([]);
    expect(desktop.runs).toEqual([]);
  });

  it('[R6-05] an automatic rerun cannot set off an agent that may write files, whoever asks', async () => {
    const b = task(CODEX, 'question b');
    await expect(useStore.getState().rerunNode(b, { auto: true })).resolves.toEqual({ status: 'needs-approval' });
    expect(desktop.runs).toEqual([]);
    await run(b);
    expect(desktop.runs.length).toBe(1);
  });

  it('[R6-05] a plan made on one canvas does nothing on the next: the person left, and the steps wait', async () => {
    const a = task(API_MODEL, 'question a');
    const b = task(API_MODEL, 'question b', a);
    await run(a);
    await run(b);
    streamed = [];
    const plan = planReplay([a], 'downstream');
    respond = () => {
      if (streamed.at(-1) === 'question a') useProjects.setState({ projects: [...useProjects.getState().projects, { id: 'canvas-2', name: 'other', createdAt: 0, updatedAt: 0 }], activeId: 'canvas-2' });
      return answer('ANSWER');
    };
    const outcome = await runReplay(plan);
    expect(asks()).toEqual(['question a']);
    expect(outcome.ran).not.toContain(b);
    expect(outcome.waiting).toEqual([b]);
  });
});

describe('[R6-07] an answer is judged by what it was given itself', () => {
  /** A task reading a file, answered twice, on OLD and on NEW. */
  async function twoVersions() {
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'OLD\n'), { x: 0, y: 0 });
    const t = task(API_MODEL, 'what does it say?', m);
    respond = () => answer('OLD ANSWER');
    await run(t);
    const fileId = fileIdOf('notes/a.md');
    shell.editExternally(fileId, 'NEW\n');
    await vi.waitFor(() => expect(node(m).data.attachments[0].content).toBe('NEW\n'));
    respond = () => answer('NEW ANSWER');
    await run(t);
    expect(node(t).data.responses).toEqual(['OLD ANSWER', 'NEW ANSWER']);
    expect(detectStale(useStore.getState())).toEqual([]);
    return { m, t, fileId };
  }
  const reasons = (id: string) => detectStale(useStore.getState()).filter((r) => r.nodeId === id);

  it('[R6-07] the newest answer deleted: the old one back on show is said to be out of date, by its own run', async () => {
    const { t, fileId } = await twoVersions();
    const oldRun = node(t).data.runs![0]!;
    useStore.getState().deleteVersion(t, 1);
    expect(node(t).data.response).toBe('OLD ANSWER');
    expect(reasons(t)).toEqual([expect.objectContaining({ kind: 'input-changed', fileId, inputId: oldRun.inputs[0].inputId })]);
    expect(node(t).data.lastRun?.runId).toBe(oldRun.runId);
  });

  it('[R6-07] an old answer shown again is out of date; the newest shown again is not', async () => {
    const { t } = await twoVersions();
    useStore.getState().navigateVersion(t, 'prev');
    expect(node(t).data.response).toBe('OLD ANSWER');
    expect(reasons(t).map((r) => r.kind)).toEqual(['input-changed']);
    useStore.getState().navigateVersion(t, 'next');
    expect(node(t).data.response).toBe('NEW ANSWER');
    expect(reasons(t)).toEqual([]);
  });

  it('[R6-07] an answer in the middle deleted: the one on show keeps its own run, and the rest theirs', async () => {
    const { m, t } = await twoVersions();
    shell.editExternally(fileIdOf('notes/a.md'), 'NEWEST\n');
    await vi.waitFor(() => expect(node(m).data.attachments[0].content).toBe('NEWEST\n'));
    respond = () => answer('NEWEST ANSWER');
    await run(t);
    const newest = node(t).data.runs![2]!;
    useStore.getState().deleteVersion(t, 1);
    expect(node(t).data.responses).toEqual(['OLD ANSWER', 'NEWEST ANSWER']);
    expect(reasons(t)).toEqual([]);
    expect(node(t).data.lastRun?.runId).toBe(newest.runId);
    useStore.getState().navigateVersion(t, 'prev');
    expect(reasons(t).map((r) => r.kind)).toEqual(['input-changed']);
  });

  it('[R6-07] the file lost: an old answer back on show says so', async () => {
    const { t, fileId, m } = await twoVersions();
    useStore.getState().deleteVersion(t, 1);
    patch(m, { resourceHint: { ...node(m).data.resourceHint!, status: 'missing' } });
    expect(reasons(t)).toEqual([expect.objectContaining({ kind: 'input-lost', fileId })]);
  });

  /** A task reading an answer upstream (no file): answered on its first answer, then on its second. */
  async function upstreamVersions() {
    const up = task(API_MODEL, 'upstream');
    respond = () => answer('UP ONE');
    await run(up);
    const t = task(API_MODEL, 'below', up);
    respond = () => answer('BELOW ONE');
    await run(t);
    respond = () => answer('UP TWO');
    await run(up);
    respond = () => answer('BELOW TWO');
    await run(t);
    expect(reasons(t)).toEqual([]);
    return { up, t };
  }

  it('[R6-07] an answer above changed: the old answer back on show is out of date, and is not cleared by the deleted one\'s fingerprint', async () => {
    const { t } = await upstreamVersions();
    useStore.getState().deleteVersion(t, 1);
    expect(node(t).data.response).toBe('BELOW ONE');
    expect(reasons(t)).toEqual([expect.objectContaining({ kind: 'upstream-changed' })]);
  });

  it('[R6-07] switching back and forth: each answer is judged by the fingerprint of its own, with what changed named', async () => {
    const { up, t } = await upstreamVersions();
    useStore.getState().navigateVersion(t, 'prev');
    expect(reasons(t)).toEqual([expect.objectContaining({ kind: 'upstream-changed', via: [up] })]);
    useStore.getState().navigateVersion(t, 'next');
    expect(reasons(t)).toEqual([]);
  });

  it('[R6-07] an old version with no record of what it was given borrows nobody\'s: nothing is claimed of it, and nothing stops the newest being judged', async () => {
    const { t } = await upstreamVersions();
    const runs = node(t).data.runs!;
    patch(t, { runs: [undefined, runs[1]] });
    useStore.getState().navigateVersion(t, 'prev');
    expect(node(t).data.response).toBe('BELOW ONE');
    expect(reasons(t)).toEqual([]);
    useStore.getState().navigateVersion(t, 'next');
    expect(reasons(t)).toEqual([]);
  });

  it('[R6-07] the newest of two with no run records deleted: its fingerprint does not stand for the one left', async () => {
    const { t } = await upstreamVersions();
    patch(t, { runs: undefined, lastRun: undefined });
    useStore.getState().deleteVersion(t, 1);
    expect(node(t).data.response).toBe('BELOW ONE');
    expect(node(t).data.lastContextHash).toBeUndefined();
    expect(reasons(t)).toEqual([]);
  });

  it('[R6-07] an answer written before versions kept their own runs, the newest, is still judged by what the node recorded', async () => {
    const { up, t } = await upstreamVersions();
    const runs = node(t).data.runs!.map((r) => (r ? { ...r, contextHash: undefined, contextParts: undefined } : r));
    patch(t, { runs });
    expect(reasons(t)).toEqual([]);
    patch(up, { response: 'UP CHANGED', responses: ['UP ONE', 'UP CHANGED'] });
    expect(reasons(t).map((r) => r.kind)).toEqual(['upstream-changed']);
  });
});
