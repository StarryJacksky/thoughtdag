import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { snapshotsOfVersion } from '../../src/lib/context/run-records';
import { detectStale } from '../../src/lib/context/staleness';
import { planReplay, runReplay } from '../../src/lib/context/replay-plan';
import { shownStaleIds } from '../../src/lib/stale-judge';
import { documents } from '../../src/lib/documents/document-service';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { subscribeWorkspace } from '../../src/lib/workspace/events';
import { moveFile } from '../../src/lib/workspace/client';
import { applyWorkspaceEvent, attachEntry } from '../../src/lib/workspace/graph-resource';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { installFakeWorkspace, type FakeWorkspace } from '../helpers/fake-workspace';

// Where an answer came from, and what has changed since. Each run is
// recorded in the workspace it read from; an earlier answer still finds
// the snapshots it was given. A file that changes marks the answers whose
// runs read it, and nothing else: a rename, a card moved or folded, a mind
// map whose nodes are only moved about mark nothing. A replay is planned in
// the order things depend on each other, makes new versions beside the old
// ones, and never sets off an agent that can write files on its own.

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
let shell: FakeWorkspace;
let desktop: FakeDesktop;
let stop: (() => void) | null = null;
let answers = 0;
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const fileIdOf = (relativePath: string) => [...shell.files.values()].find((f) => f.relativePath === relativePath)!.fileId;
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false });
const MODELS = () => ({ models: [model(CODEX), model(API_MODEL)], default: null });
const recompute = () => { useStore.getState().recomputeStaleness(); return useStore.getState().staleIds; };
const reasonsOf = (id: string) => detectStale(useStore.getState()).filter((r) => r.nodeId === id);
const copyOf = (id: string) => node(id).data.attachments[0]?.content;

/** A task asking `question`, wired to what it reads; not run yet. */
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
  answers = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(MODELS());
    if (url.endsWith('/api/stream')) return new Response(`data: ${JSON.stringify({ text: `ANSWER_${++answers}` })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error(`Unexpected network request: ${url}`);
  });
  desktop = installFakeDesktop();
  shell = installFakeWorkspace();
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {} });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false, autoRefreshPaused: false });
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
});

describe('what an answer was given', () => {
  it('[T13] a run is recorded in the workspace it read from: prepared before it is sent, and how it ended after', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A1\n'), { x: 0, y: 0 });
    const t = task(API_MODEL, 'What does it say?', a);
    await run(t);
    const runId = node(t).data.lastRun!.runId;
    const history = shell.runRecords.filter((r) => r.workspaceId === 'ws_1' && r.record.runId === runId);
    expect(history.map((r) => r.record.state)).toEqual(['prepared', 'completed']);
    const ended = history.at(-1)!.record;
    expect(ended.output).toEqual({ versionIndex: 0, chars: 'ANSWER_1'.length });
    expect(ended.inputs).toEqual([expect.objectContaining({ fileId: fileIdOf('notes/a.md'), snapshotId: node(t).data.lastRun!.inputs[0].snapshotId })]);
    expect(ended.inputDigest).toBe(node(t).data.lastRun!.inputDigest);
  });

  it('[T13] an earlier answer finds the snapshots it was given, after the file has changed and the task has run again', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'FIRST_A1\n'), { x: 0, y: 0 });
    const t = task(API_MODEL, 'What does it say?', a);
    await run(t);
    shell.editExternally(fileIdOf('notes/a.md'), 'SECOND_A2\n');
    await vi.waitFor(() => expect(copyOf(a)).toBe('SECOND_A2\n'));
    await run(t);
    expect(node(t).data.responses).toEqual(['ANSWER_1', 'ANSWER_2']);
    const [first] = snapshotsOfVersion(t, 0);
    const [second] = snapshotsOfVersion(t, 1);
    expect(first.fileId).toBe(fileIdOf('notes/a.md'));
    expect((await first.read()).payload).toBe('FIRST_A1\n');
    expect((await second.read()).payload).toBe('SECOND_A2\n');
    expect(snapshotsOfVersion(t, 5)).toEqual([]);
  });
});

describe('what has changed since', () => {
  it('[T13] a file that changes marks the answers whose runs read it, and only those', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A1\n'), { x: 0, y: 0 });
    const b = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/b.md', 'B1\n'), { x: 300, y: 0 });
    const ta = task(API_MODEL, 'about a', a);
    const tb = task(API_MODEL, 'about b', b);
    for (const id of [ta, tb]) await run(id);
    expect(recompute()).toEqual([]);
    shell.editExternally(fileIdOf('notes/a.md'), 'A2\n');
    await vi.waitFor(() => expect(copyOf(a)).toBe('A2\n'));
    expect(recompute()).toEqual([ta]);
    expect(reasonsOf(ta)).toEqual([expect.objectContaining({ kind: 'input-changed', fileId: fileIdOf('notes/a.md'), name: 'a.md' })]);
    expect(reasonsOf(tb)).toEqual([]);
  });

  it('[T13] a file that is lost is said to be lost, for the answers that read it', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A1\n'), { x: 0, y: 0 });
    const t = task(API_MODEL, 'about a', a);
    await run(t);
    await window.desktopWorkspace!.trashFile(fileIdOf('notes/a.md'), 'op-trash');
    await vi.waitFor(() => expect(node(a).data.resourceHint!.status).toBe('missing'));
    expect(reasonsOf(t)).toEqual([expect.objectContaining({ kind: 'input-lost', fileId: fileIdOf('notes/a.md') })]);
    expect(recompute()).toEqual([t]);
  });

  it('[T13] renaming a file, and moving or folding cards, mark nothing', async () => {
    const a = await attachEntry(CANVAS, 'ws_1', shell.seed('notes/a.md', 'A1\n'), { x: 0, y: 0 });
    const t = task(API_MODEL, 'about a', a);
    await run(t);
    await moveFile(fileIdOf('notes/a.md'), undefined, 'renamed.md', 'op-rename');
    await vi.waitFor(() => expect(node(a).data.resourceHint!.name).toBe('renamed.md'));
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => ({ ...n, position: { x: n.position.x + 400, y: n.position.y + 50 }, data: { ...n.data, isCollapsed: true } })) }));
    expect(recompute()).toEqual([]);
    expect(detectStale(useStore.getState())).toEqual([]);
  });

  it('[T13] a mind map whose nodes are only moved about marks nothing; one whose words change marks what read it', async () => {
    const map = (text: string, x: number) => JSON.stringify({ format: 'thoughtdag-mindmap', schemaVersion: '1.0', documentId: 'map_1', title: 'Plan', roots: ['n1'], nodes: [{ id: 'n1', text, children: [] }], relations: [], sources: [], payloads: [], layout: { positions: { n1: { x, y: 0 } }, collapsed: [] } }, null, 2) + '\n';
    const m = await attachEntry(CANVAS, 'ws_1', shell.seed('maps/plan.tdmap', map('ROOT_IDEA', 0)), { x: 0, y: 0 });
    const t = task(API_MODEL, 'about the map', m);
    await run(t);
    shell.editExternally(fileIdOf('maps/plan.tdmap'), map('ROOT_IDEA', 240));
    await vi.waitFor(() => expect(copyOf(m)).toContain('240'));
    await vi.waitFor(() => expect(node(m).data.resourceHint!.meaning?.revision).toBe(node(m).data.resourceHint!.revision));
    expect(recompute()).toEqual([]);
    expect(reasonsOf(t)).toEqual([]);
    shell.editExternally(fileIdOf('maps/plan.tdmap'), map('ANOTHER_IDEA', 240));
    await vi.waitFor(() => expect(copyOf(m)).toContain('ANOTHER_IDEA'));
    await vi.waitFor(() => expect(node(m).data.resourceHint!.meaning?.revision).toBe(node(m).data.resourceHint!.revision));
    expect(recompute()).toEqual([t]);
    expect(reasonsOf(t)).toEqual([expect.objectContaining({ kind: 'input-changed', name: 'plan.tdmap' })]);
  });
});

describe('replaying', () => {
  /** An answer with a mistake in it, wired by reference into a task, whose answer a task below it reads. */
  async function polluted() {
    const wrong = task(API_MODEL, 'the figure');
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === wrong ? { ...n, data: { ...n.data, response: 'WRONG_FIGURE_X1', responses: ['WRONG_FIGURE_X1'], responseIndex: 0 } } : n)) }));
    const middle = task(API_MODEL, 'what follows from it');
    useStore.setState((st) => ({ edges: [...st.edges, { id: `ref-${wrong}-${middle}`, source: wrong, target: middle, data: { isCrossLink: true } }] }));
    const lower = task(API_MODEL, 'and then', middle);
    const aside = task(API_MODEL, 'unrelated');
    for (const id of [middle, lower, aside]) await run(id);
    expect(recompute()).toEqual([]);
    return { wrong, middle, lower, aside };
  }

  it('[T13] a mistake taken out upstream shows what read it below, and in which order to replay it', async () => {
    const { wrong, middle, lower, aside } = await polluted();
    useStore.getState().deleteNode(wrong);
    await settled();
    expect(node(middle)).toBeDefined();
    expect(recompute()).toContain(middle);
    expect(recompute()).not.toContain(aside);
    expect(reasonsOf(middle)).toEqual([expect.objectContaining({ kind: 'upstream-changed' })]);
    const plan = planReplay([middle], 'downstream');
    expect(plan.steps.map((s) => s.nodeId)).toEqual([middle, lower]);
    expect(plan.steps[1].after).toEqual([middle]);
    expect(plan.steps.every((s) => s.action === 'rerun')).toBe(true);
    expect(planReplay([middle], 'target-only').steps.map((s) => s.nodeId)).toEqual([middle]);
    expect(planReplay([lower, middle], 'target-only').steps.map((s) => s.nodeId)).toEqual([middle, lower]);
    expect(planReplay([middle], 'keep').steps).toEqual([]);
    expect(plan.steps.some((s) => s.nodeId === aside)).toBe(false);
  });

  it('[T13] a replay makes new versions and keeps the old ones as they were', async () => {
    const { wrong, middle, lower } = await polluted();
    useStore.getState().deleteNode(wrong);
    await settled();
    recompute();
    const before = { middle: node(middle).data.responses, lower: node(lower).data.responses };
    const outcome = await runReplay(planReplay([middle], 'downstream'));
    expect(outcome).toEqual({ ran: [middle, lower], waiting: [] });
    expect(node(middle).data.responses).toEqual([...before.middle, expect.stringMatching(/^ANSWER_/)]);
    expect(node(lower).data.responses).toEqual([...before.lower, expect.stringMatching(/^ANSWER_/)]);
    expect(node(middle).data.runs?.length).toBe(2);
    expect(recompute()).toEqual([]);
  });

  it('[T13] keeping the old result is said and kept, until something changes again', async () => {
    const { wrong, middle, lower } = await polluted();
    useStore.getState().deleteNode(wrong);
    await settled();
    recompute();
    await runReplay(planReplay([middle], 'keep'));
    expect(shownStaleIds(useStore.getState())).not.toContain(middle);
    expect(node(middle).data.responses.length).toBe(1);
    expect(node(lower).data.responses.length).toBe(1);
    // shown again once something else it reads changes
    const extra = task(API_MODEL, 'another figure');
    useStore.setState((st) => ({
      nodes: st.nodes.map((n) => (n.id === extra ? { ...n, data: { ...n.data, response: 'ANOTHER_FIGURE_Y2', responses: ['ANOTHER_FIGURE_Y2'], responseIndex: 0 } } : n)),
      edges: [...st.edges, { id: `ref-${extra}-${middle}`, source: extra, target: middle, data: { isCrossLink: true } }],
    }));
    recompute();
    expect(shownStaleIds(useStore.getState())).toContain(middle);
  });

  it('[T13] an agent that can write files is not run again on its own: a replay and an automatic rerun wait for the person', async () => {
    const upper = task(API_MODEL, 'the plan');
    await run(upper);
    const agent = task(CODEX, 'carry it out', upper);
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === agent ? { ...n, data: { ...n.data, autoRerun: true } } : n)) }));
    await run(agent);
    expect(desktop.runs.length).toBe(1);
    // the plan above is asked again: the agent below would rerun on its own, and does not
    await run(upper);
    for (let i = 0; i < 5; i++) await settled();
    expect(desktop.runs.length).toBe(1);
    expect(recompute()).toEqual([agent]);
    const plan = planReplay([agent], 'target-only');
    expect(plan.steps).toEqual([expect.objectContaining({ nodeId: agent, action: 'needs-approval' })]);
    expect(await runReplay(plan)).toEqual({ ran: [], waiting: [agent] });
    await useStore.getState().replayStale();
    for (let i = 0; i < 5; i++) await settled();
    expect(desktop.runs.length).toBe(1);
    // the person runs it: it runs
    await run(agent);
    expect(desktop.runs.length).toBe(2);
  });
});
