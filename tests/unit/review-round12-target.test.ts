import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { planReplay, runReplay } from '../../src/lib/context/replay-plan';
import { makeNode } from '../../src/lib/import-chat';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtData, ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What the review of the R6-05 fix found (R12-02): an automatic run was judged
// by what the task itself says, and what it runs on is settled later, in the
// pipeline: a task bound to nothing may come to the toolbar's pick or the
// server's default, and a pin that cannot be reached is replaced. So an
// automatic run could set off an agent that may write files. All of it on
// stand-ins for the desktop shell and the model server: what is checked is what
// the shell is asked to do, never a real agent.

// what happens while a run waits for the list of models is what some of this is about
const during = vi.hoisted(() => ({ models: null as null | (() => void), noList: false }));
vi.mock('../../src/lib/use-models', async (original) => {
  const real = await original<typeof import('../../src/lib/use-models')>();
  return {
    ...real,
    getModelsOnce: async () => {
      const hook = during.models;
      during.models = null;
      if (hook) { await new Promise((resolve) => setTimeout(resolve, 0)); hook(); }
      return during.noList ? null : real.getModelsOnce();
    },
  };
});

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const API_MODEL = 'synthetic-provider/model';
const REMOVED = 'removed-provider/retired-for-good';
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.startsWith('codex/') ? '__agent__' : id.split('/')[0], vision: false, tools: false, webSearch: false, scholarSearch: false });
const models = (def: string | null = null) => ({ models: [model(CODEX), model(API_MODEL)], default: def });

let desktop: FakeDesktop;
let posted: { model?: string }[] = [];
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const patch = (id: string, data: Partial<ThoughtData>) => useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...data } } : n)) }));
const pick = (id: string | null) => useUiStore.getState().setSelectedModel(id);

/** A task on an old canvas: an answer it was given before tasks were bound to an AI. */
function oldTask(id: string, data: Partial<ThoughtData> = {}): string {
  const made = makeNode(`The question of ${id}?`, `THE_OLD_ANSWER_OF_${id}`, true) as ThoughtNode;
  useStore.setState((st) => ({ nodes: [...st.nodes, { ...made, id, data: { ...made.data, ...data } }] }));
  return id;
}
const wire = (source: string, target: string) => useStore.setState((st) => ({ edges: [...st.edges, { id: `edge-${source}-${target}`, source, target }] }));
const bound = (modelId: string, data: Partial<ThoughtData> = {}) => {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 + 200 * useStore.getState().nodes.length });
  patch(id, { question: 'A question of a bound task?', ...data });
  return id;
};

/** Nothing went out, nothing was written for it, and the task is as it was. */
function nothingHappened(id: string, before: ThoughtData) {
  expect(desktop.runs).toEqual([]);
  expect(desktop.materials).toEqual([]);
  expect(posted).toEqual([]);
  const after = node(id).data;
  expect(after.target).toEqual(before.target);
  expect(after.model).toBe(before.model);
  expect(after.response).toBe(before.response);
  expect(after.responses).toEqual(before.responses);
  expect(after.isLoading).toBeFalsy();
  expect(after.restreaming).toBeFalsy();
  expect(after.generationFailed).toBeFalsy();
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  posted = [];
  during.models = null;
  during.noList = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/models')) return Response.json(models());
    if (url.endsWith('/api/stream')) {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(`data: ${JSON.stringify({ text: 'SYNTHETIC_ANSWER' })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({});
  });
  desktop = installFakeDesktop();
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {} });
  useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
  useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false, autoRefreshPaused: false });
  setModelsCache(models());
  await recheckAgents();
  setModelsCache(models());
  pick(API_MODEL);
});
afterEach(() => {
  desktop.uninstall();
  vi.unstubAllGlobals();
  setModelsCache({ models: [], default: null });
  useStore.setState({ nodes: [], edges: [], staleIds: [], staleFps: {}, staleVerdicts: {} });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  pick(null);
});

const auto = (id: string, more: { expect?: string; mayWrite?: boolean } = {}) => useStore.getState().rerunNode(id, { auto: true, ...more });

describe('[R12-02] an automatic run does not come to an agent that may write files', () => {
  const refused: [string, () => string][] = [
    ['no model, the toolbar on an agent', () => { pick(CODEX); return oldTask('a'); }],
    ['no model, nothing on the toolbar, the server\'s default an agent', () => { pick(null); setModelsCache(models(CODEX)); return oldTask('a'); }],
    ['a pin that cannot be reached, the toolbar on an agent', () => { pick(CODEX); return oldTask('a', { model: REMOVED }); }],
    ['a pin that cannot be reached, nothing on the toolbar, the server\'s default an agent', () => { pick(null); setModelsCache(models(CODEX)); return oldTask('a', { model: REMOVED }); }],
    ['no model, nothing on the toolbar, no default: no AI can be named', () => { pick(null); return oldTask('a'); }],
    ['no model, nothing on the toolbar, the list of models not known: no AI can be named', () => { pick(null); during.noList = true; return oldTask('a'); }],
  ];
  for (const [name, make] of refused) {
    it(`[R12-02] ${name}: it waits for the person, and the task is left as it was`, async () => {
      const id = make();
      const before = structuredClone(node(id).data);
      expect(await auto(id)).toEqual({ status: 'needs-approval' });
      nothingHappened(id, before);
    });
  }

  it('[R12-02] the toolbar goes from an API model to an agent while the run waits for the list: it waits for the person', async () => {
    const id = oldTask('a');
    const before = structuredClone(node(id).data);
    during.models = () => pick(CODEX);
    expect(await auto(id, { expect: 'model:' })).toEqual({ status: 'needs-approval' });
    nothingHappened(id, before);
  });

  it('[R12-02] the task is given an agent while the run waits for the list: it waits for the person, and keeps what it was given', async () => {
    const id = oldTask('a');
    const agent = createTarget(templateFor(CODEX));
    during.models = () => patch(id, { target: agent });
    expect(await auto(id, { expect: 'model:' })).toEqual({ status: 'needs-approval' });
    expect(desktop.runs).toEqual([]);
    expect(desktop.materials).toEqual([]);
    expect(posted).toEqual([]);
    expect(node(id).data.target).toEqual(agent);
    expect(node(id).data.response).toBe('THE_OLD_ANSWER_OF_a');
    expect(node(id).data.isLoading).toBeFalsy();
  });

  it('[R12-02] the task is given another API model while the run waits for the list: not what was planned, so it does not start', async () => {
    const id = bound(API_MODEL);
    const other = createTarget(templateFor(API_MODEL));
    const planned = `${node(id).data.target!.targetId}@${node(id).data.target!.revision}`;
    during.models = () => patch(id, { target: other });
    expect(await auto(id, { expect: planned })).toEqual({ status: 'needs-approval' });
    expect(posted).toEqual([]);
    expect(node(id).data.target).toEqual(other);
  });

  it('[R12-02] a summary task (one that reads a material) that comes to an agent is left as it was too', async () => {
    pick(CODEX);
    oldTask('m', { attachments: [{ id: 'att-1', name: 'a.txt', type: 'text/plain', content: 'x', extractedText: 'THE_MATERIAL_TEXT' }] as ThoughtData['attachments'] });
    const id = oldTask('d', { digestOf: 'att-1' });
    const before = structuredClone(node(id).data);
    expect(await auto(id)).toEqual({ status: 'needs-approval' });
    nothingHappened(id, before);
  });

  it('[R12-02] when a change upstream comes to an agent only as it starts, the person is told, as when it is known beforehand', async () => {
    pick(null);
    setModelsCache(models(CODEX));
    const up = bound(API_MODEL);
    const down = oldTask('down', { autoRerun: true });
    wire(up, down);
    const before = structuredClone(node(down).data);
    expect(await useStore.getState().rerunNode(up, {})).toMatchObject({ status: 'answered' });
    posted = [];
    await vi.waitFor(() => expect(useUiStore.getState().toasts.some((x) => x.message.includes(before.question.slice(0, 20)))).toBe(true));
    nothingHappened(down, before);
  });
});

describe('[R12-02] a replay', () => {
  it('[R12-02] plans a task bound to nothing by what it would run on: the toolbar on an agent, it waits, and so does what reads it', async () => {
    pick(CODEX);
    const a = oldTask('a');
    const b = oldTask('b', { model: API_MODEL });
    wire(a, b);
    const plan = planReplay([a], 'downstream');
    expect(plan.steps.map((s) => s.action)).toEqual(['needs-approval', 'rerun']);
    const out = await runReplay(plan);
    expect(out.ran).toEqual([]);
    expect(out.waiting).toEqual([a, b]);
    expect(desktop.runs).toEqual([]);
    expect(desktop.materials).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('[R12-02] a pin that comes to an agent only as it starts: the step and what reads it wait, and neither is said to have failed', async () => {
    pick(CODEX);
    const a = oldTask('a', { model: REMOVED });
    const b = oldTask('b', { model: API_MODEL });
    const c = oldTask('c', { model: API_MODEL });
    wire(a, b);
    const beforeA = structuredClone(node(a).data);
    const out = await runReplay(planReplay([a, c], 'downstream'));
    expect(out.ran).toEqual([c]);
    expect(out.waiting).toEqual([a, b]);
    expect(out.failed).toBeUndefined();
    expect(desktop.runs).toEqual([]);
    expect(posted).toHaveLength(1);
    nothingHappenedExceptOthers(a, beforeA);
  });

  it('[R12-02] the toolbar goes to an agent between the plan and the step: it waits', async () => {
    const a = oldTask('a');
    const plan = planReplay([a], 'target-only');
    expect(plan.steps[0].action).toBe('rerun');
    pick(CODEX);
    const out = await runReplay(plan);
    expect(out).toMatchObject({ ran: [], waiting: [a] });
    expect(desktop.runs).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('[R12-02] the toolbar goes to an agent while the step waits for the list: it waits', async () => {
    const a = oldTask('a');
    const plan = planReplay([a], 'target-only');
    during.models = () => pick(CODEX);
    const out = await runReplay(plan);
    expect(out).toMatchObject({ ran: [], waiting: [a] });
    expect(desktop.runs).toEqual([]);
    expect(posted).toEqual([]);
  });
});

/** The one task is as it was; other tasks of the same replay ran. */
function nothingHappenedExceptOthers(id: string, before: ThoughtData) {
  const after = node(id).data;
  expect(after.target).toEqual(before.target);
  expect(after.model).toBe(before.model);
  expect(after.response).toBe(before.response);
  expect(after.isLoading).toBeFalsy();
}

describe('[R12-02] what may run still runs', () => {
  it('[R12-02] control: a task bound to an agent, automatic: refused, as before', async () => {
    const id = bound(CODEX);
    expect(await auto(id)).toEqual({ status: 'needs-approval' });
    expect(desktop.runs).toEqual([]);
    expect(desktop.materials).toEqual([]);
  });

  it('[R12-02] control: a task bound to an API model runs on it, whatever the toolbar says', async () => {
    pick(CODEX);
    const id = bound(API_MODEL);
    expect(await auto(id)).toMatchObject({ status: 'answered' });
    expect(posted).toHaveLength(1);
    expect(desktop.runs).toEqual([]);
  });

  it('[R12-02] control: bound to nothing, an API model pinned or on the toolbar: it runs, and is bound to that', async () => {
    const pinned = oldTask('a', { model: API_MODEL });
    expect(await auto(pinned)).toMatchObject({ status: 'answered' });
    expect(node(pinned).data.target?.model).toBe(API_MODEL);
    const toolbar = oldTask('b');
    expect(await auto(toolbar)).toMatchObject({ status: 'answered' });
    expect(node(toolbar).data.target?.model).toBe(API_MODEL);
    expect(desktop.runs).toEqual([]);
  });

  it('[R12-02] control: a pin that cannot be reached with an API model on the toolbar runs on that, and says so', async () => {
    const id = oldTask('a', { model: REMOVED });
    expect(await auto(id, { expect: `model:${REMOVED}` })).toMatchObject({ status: 'answered' });
    expect(node(id).data.target?.model).toBe(API_MODEL);
    expect(desktop.runs).toEqual([]);
  });

  it('[R12-02] control: the server\'s default an API model, nothing on the toolbar: it runs', async () => {
    pick(null);
    setModelsCache(models(API_MODEL));
    const id = oldTask('a');
    expect(await auto(id)).toMatchObject({ status: 'answered' });
    expect(node(id).data.target?.model).toBe(API_MODEL);
  });

  it('[R12-02] control: a task set to research on an agent is not held back as a writer: it is stopped by what research asks of an agent, and says so', async () => {
    const id = newTask(createTarget({ ...templateFor(CODEX), policyId: 'research' }), { x: 0, y: 600 });
    patch(id, { question: 'Research this?' });
    expect(await auto(id)).toEqual({ status: 'not-sent' });
    expect(desktop.runs).toEqual([]);
    expect(node(id).data.response).not.toBe('');
  });

  it('[R12-02] control: a task set to research on an API model runs', async () => {
    const id = newTask(createTarget({ ...templateFor(API_MODEL), policyId: 'research' }), { x: 0, y: 600 });
    patch(id, { question: 'Research this?' });
    expect(await auto(id)).toMatchObject({ status: 'answered' });
  });

  for (const [name, make] of [
    ['bound to nothing, the toolbar on an agent', () => { pick(CODEX); return oldTask('a'); }],
    ['bound to an agent', () => bound(CODEX)],
    ['a pin that cannot be reached, the toolbar on an agent', () => { pick(CODEX); return oldTask('a', { model: REMOVED }); }],
  ] as [string, () => string][]) {
    it(`[R12-02] control: what the person set going themselves (mayWrite), ${name}: the agent runs`, async () => {
      const id = make();
      expect(await auto(id, { mayWrite: true })).toMatchObject({ status: 'answered' });
      expect(desktop.runs).toHaveLength(1);
    });

    it(`[R12-02] control: a run the person asks for, ${name}: the agent runs`, async () => {
      const id = make();
      expect(await useStore.getState().rerunNode(id, {})).toMatchObject({ status: 'answered' });
      expect(desktop.runs).toHaveLength(1);
    });
  }
});
