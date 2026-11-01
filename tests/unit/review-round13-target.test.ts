import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { actsAsAgent, isHarnessAgentModel } from '../../src/lib/agents/agent-runtime';
import { createTarget, describeTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import { checkSend, kindOf, writesFiles } from '../../src/lib/agents/target-model';
import { planReplay, runReplay } from '../../src/lib/context/replay-plan';
import { makeNode } from '../../src/lib/import-chat';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import type { ThoughtData, ThoughtNode } from '../../src/types';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What the review of the R12-02 fix found (R13-02): the agent the embedded
// harness runs was classified as a model called through an API, because its name
// is not among the runtimes'. An automatic run, or a replay, could set it off,
// though it runs in the canvas's folder with tools that write. All of it on
// stand-ins for the desktop shell and the model server: what is checked is what
// is asked for, never a real agent or model.

const during = vi.hoisted(() => ({ models: null as null | (() => void) }));
vi.mock('../../src/lib/use-models', async (original) => {
  const real = await original<typeof import('../../src/lib/use-models')>();
  return {
    ...real,
    getModelsOnce: async () => {
      const hook = during.models;
      during.models = null;
      if (hook) { await new Promise((resolve) => setTimeout(resolve, 0)); hook(); }
      return real.getModelsOnce();
    },
  };
});

const CANVAS = 'canvas-1';
const API_MODEL = 'synthetic-provider/model';
const REMOVED = 'removed-provider/retired-for-good';
const HARNESS = ['harness/agent', 'harness/agent/synthetic-provider/model'];
const model = (id: string) => ({ id, name: id.split('/').pop()!, provider: id.split('/')[0], vision: false, tools: false, webSearch: false, scholarSearch: false });
const models = (def: string | null = null) => ({ models: [...HARNESS, API_MODEL].map(model), default: def });

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
const bound = (modelId: string) => {
  const id = newTask(createTarget(templateFor(modelId)), { x: 0, y: 600 + 200 * useStore.getState().nodes.length });
  patch(id, { question: 'A question of a bound task?', response: 'THE_OLD_ANSWER' });
  return id;
};
/** A task bound before this was fixed: its record says a provider, and names the harness's agent. */
const boundAsProvider = (modelId: string) => {
  const id = bound(API_MODEL);
  const t = node(id).data.target!;
  patch(id, { model: modelId, target: { ...t, kind: 'provider', runtime: null, model: modelId, connectionRef: 'provider:harness' } });
  return id;
};

function nothingHappened(id: string, before: ThoughtData) {
  expect(desktop.runs).toEqual([]);
  expect(desktop.materials).toEqual([]);
  expect(posted).toEqual([]);
  const after = node(id).data;
  expect(after.target).toEqual(before.target);
  expect(after.model).toBe(before.model);
  expect(after.response).toBe(before.response);
  expect(after.isLoading).toBeFalsy();
  expect(after.generationFailed).toBeFalsy();
}

beforeAll(() => bootProjects());
beforeEach(async () => {
  posted = [];
  during.models = null;
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

const auto = (id: string) => useStore.getState().rerunNode(id, { auto: true });

for (const harness of HARNESS) {
  describe(`[R13-02] ${harness}: an automatic run does not set it off`, () => {
    const cases: [string, () => string][] = [
      ['no model, the toolbar on it', () => { pick(harness); return oldTask('a'); }],
      ['pinned to it', () => oldTask('a', { model: harness })],
      ['a pin that cannot be reached, the toolbar on it', () => { pick(harness); return oldTask('a', { model: REMOVED }); }],
      ['nothing on the toolbar, it is the server\'s default', () => { pick(null); setModelsCache(models(harness)); return oldTask('a'); }],
      ['bound to it', () => bound(harness)],
      ['bound to it by a record that says provider', () => boundAsProvider(harness)],
    ];
    for (const [name, make] of cases) {
      it(`[R13-02] ${name}: it waits for the person, and the task is left as it was`, async () => {
        const id = make();
        const before = structuredClone(node(id).data);
        expect(await auto(id)).toEqual({ status: 'needs-approval' });
        nothingHappened(id, before);
      });
    }

    it('[R13-02] the toolbar goes to it while the run waits for the list: it waits for the person', async () => {
      const id = oldTask('a');
      const before = structuredClone(node(id).data);
      during.models = () => pick(harness);
      expect(await auto(id)).toEqual({ status: 'needs-approval' });
      nothingHappened(id, before);
    });

    it('[R13-02] a replay plans to ask the person first, and does not start it', async () => {
      pick(harness);
      const unbound = oldTask('u');
      const old = boundAsProvider(harness);
      const plan = planReplay([unbound, old], 'target-only');
      expect(plan.steps.map((s) => s.action)).toEqual(['needs-approval', 'needs-approval']);
      const before = structuredClone(node(old).data);
      await runReplay(plan);
      nothingHappened(old, before);
    });

    it('[R13-02] a change upstream does not set it off, and the person is told', async () => {
      const up = bound(API_MODEL);
      const down = boundAsProvider(harness);
      patch(down, { autoRerun: true });
      wire(up, down);
      const before = structuredClone(node(down).data);
      expect(await useStore.getState().rerunNode(up, {})).toMatchObject({ status: 'answered' });
      await vi.waitFor(() => expect(useUiStore.getState().toasts.length).toBeGreaterThan(0));
      expect(posted.map((p) => p.model)).toEqual([API_MODEL]);
      expect(node(down).data.response).toBe(before.response);
      expect(node(down).data.target).toEqual(before.target);
    });

    it('[R13-02] control: the person running it runs it', async () => {
      const id = boundAsProvider(harness);
      expect(await useStore.getState().rerunNode(id, {})).toMatchObject({ status: 'answered' });
      expect(posted.map((p) => p.model)).toEqual([harness]);
    });

    it('[R13-02] control: a run the person allowed to write runs it', async () => {
      const id = bound(harness);
      expect(await useStore.getState().rerunNode(id, { auto: true, mayWrite: true })).toMatchObject({ status: 'answered' });
      expect(posted.map((p) => p.model)).toEqual([harness]);
    });

    it('[R13-02] there is one answer to what it is: the template, a record that says provider, and the question of writing agree', () => {
      expect(isHarnessAgentModel(harness)).toBe(true);
      expect(actsAsAgent(harness)).toBe(true);
      const made = templateFor(harness);
      expect(made.kind).toBe('agent');
      expect(made.runtime).toBeNull();
      expect(writesFiles({ model: harness })).toBe(true);
      expect(writesFiles({ target: createTarget(made) })).toBe(true);
      expect(kindOf({ kind: 'provider', model: harness })).toBe('agent');
      expect(writesFiles({ target: { ...createTarget(made), kind: 'provider' } })).toBe(true);
    });

    it('[R13-02] it is not called a model reached through an API', () => {
      const shown = describeTarget(templateFor(harness));
      expect(shown.group).toBe('agent');
      expect(shown.label).not.toContain('API');
    });
  });
}

describe('[R13-02] what a run says it may do', () => {
  it('[R13-02] the envelope of a run of the harness\'s agent says it may write in the folder, even on a record that says provider', async () => {
    const seen: { kind?: string; write?: string }[] = [];
    const prep = await import('../../src/lib/context/prepare-run');
    const id = boundAsProvider(HARNESS[0]);
    const spy = vi.spyOn(prep, 'prepareRun');
    await useStore.getState().rerunNode(id, {});
    for (const call of spy.mock.results) { const envelope = await call.value; seen.push({ kind: envelope.runtime.kind, write: envelope.policy.write?.scope }); }
    spy.mockRestore();
    expect(seen).toEqual([{ kind: 'agent', write: 'workspace' }]);
  });

  it('[R13-02] control: a model called through an API is still that: an automatic run runs it, and it writes nothing', async () => {
    expect(actsAsAgent(API_MODEL)).toBe(false);
    expect(writesFiles({ model: API_MODEL })).toBe(false);
    const id = bound(API_MODEL);
    expect(await auto(id)).toMatchObject({ status: 'answered' });
    expect(posted.map((p) => p.model)).toEqual([API_MODEL]);
  });

  it('[R13-02] control: a target the list no longer has: a provider\'s is held back, the harness\'s is the harness\'s to know', () => {
    const list = { models: [model(API_MODEL)], serverDefault: null } as never;
    expect(checkSend({ target: createTarget(templateFor(HARNESS[1])) }, list)).toEqual({ ok: true });
    expect(checkSend({ target: { ...createTarget(templateFor(API_MODEL)), model: REMOVED } }, list)).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
