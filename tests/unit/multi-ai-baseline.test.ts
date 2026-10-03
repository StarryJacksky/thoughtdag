import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../src/store';
import { useProjects } from '../../src/store/projects';
import { useUiStore } from '../../src/lib/ui-store';
import { reconcileModelId } from '../../src/lib/use-models';
import { fixture, type FixtureTask, type ResearchFixture } from '../fixtures/research';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { gap } from '../helpers/gap';

// Several AI tasks on one canvas, as the app runs them today. Each case asks
// through the store's own addQuestion, so what is measured at the desktop
// bridge is what a real ask sends: runtime, model, effort, working
// directory, standing approvals, prompt and material files. `it` cases hold
// today and must keep holding; `gap` cases state what the plan requires of
// per-target isolation and today's code does not do.

let desktop: FakeDesktop;

function load(f: ResearchFixture, hold = false) {
  desktop = installFakeDesktop({ hold });
  useStore.setState({ nodes: f.graph.nodes, edges: f.graph.edges });
  useProjects.setState({
    projects: [{ id: 'fixture-canvas', name: f.name, createdAt: 0, updatedAt: 0, agentCwd: f.policy.cwd }],
    activeId: 'fixture-canvas',
    switching: false,
  });
  useUiStore.getState().setSelectedModel(f.policy.model);
  useUiStore.getState().setAgentEffort(f.policy.effort ?? '');
}

beforeEach(() => {
  // no proxy, no model list, no network: every fetch fails at once
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
});
afterEach(() => {
  desktop?.uninstall();
  vi.unstubAllGlobals();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
  useUiStore.getState().setSelectedModel(null);
  useUiStore.getState().setAgentEffort('');
});

const task = (f: ResearchFixture, name: string): FixtureTask => {
  const t = f.tasks?.find((x) => x.name === name);
  if (!t) throw new Error(`fixture ${f.name} has no task ${name}`);
  return t;
};

interface Asked {
  nodeId: string;
  request: DesktopAgentRunRequest;
  /** the material files written for this run */
  files: { name: string; content: string }[];
}

/** Ask the task's question from its parent and return what its run was handed. */
async function ask(t: FixtureTask): Promise<Asked> {
  const runsBefore = desktop.runs.length;
  const writesBefore = desktop.materials.length;
  await useStore.getState().addQuestion(t.question, { parentId: t.parentNodeId });
  expect(desktop.runs.length, `${t.name} started one run`).toBe(runsBefore + 1);
  const nodeId = useStore.getState().nodes.find((n) => n.data.question === t.question)!.id;
  return { nodeId, request: desktop.runs[runsBefore], files: desktop.materials.slice(writesBefore).flatMap((m) => m.files) };
}

/** Run a node again the way the app does: a sibling with the same question. */
async function rerun(asked: Asked): Promise<DesktopAgentRunRequest> {
  const before = desktop.runs.length;
  await useStore.getState().regenerate(asked.nodeId);
  expect(desktop.runs.length).toBe(before + 1);
  return desktop.runs[before];
}

describe('two lines pinned to two runtimes', () => {
  const f = fixture('two-targets');

  it('each task runs on the model its line is pinned to, whatever the toolbar says', async () => {
    load(f);
    const x = await ask(task(f, 'X'));
    const y = await ask(task(f, 'Y'));
    expect(x.request).toMatchObject({ runtime: 'codex', model: { provider: 'codex', id: 'gpt-synthetic' } });
    expect(y.request).toMatchObject({ runtime: 'claude-code', model: { provider: 'claude-code', id: 'sonnet' } });
  });

  it('each prompt holds its own material and the shared one, never the other line\'s', async () => {
    load(f);
    for (const t of [task(f, 'X'), task(f, 'Y')]) {
      const { request } = await ask(t);
      for (const marker of t.promptContains ?? []) expect(request.prompt, t.name).toContain(marker);
      for (const marker of t.promptExcludes ?? []) expect(request.prompt, t.name).not.toContain(marker);
      expect(request.prompt.endsWith(t.question)).toBe(true);
    }
  });

  it('each run is handed only its own line\'s material files', async () => {
    load(f);
    for (const t of [task(f, 'X'), task(f, 'Y')]) {
      const written = (await ask(t)).files.map((file) => file.content).join('\n');
      for (const marker of t.readableContains ?? []) expect(written, t.name).toContain(marker);
      for (const marker of t.readableExcludes ?? []) expect(written, t.name).not.toContain(marker);
    }
  });

  // A fact the isolation work starts from: the working directory belongs to
  // the canvas. Both tasks run in it, and both sets of material files are
  // written under it (tests/host/multi-ai-baseline.test.cjs shows what an
  // agent can then read).
  it('both tasks run in the canvas\'s one working directory', async () => {
    load(f);
    const x = await ask(task(f, 'X'));
    const y = await ask(task(f, 'Y'));
    expect(x.request.cwd).toBe(f.policy.cwd);
    expect(y.request.cwd).toBe(f.policy.cwd);
  });

  it('each node records the model that was asked', async () => {
    load(f);
    const x = await ask(task(f, 'X'));
    const y = await ask(task(f, 'Y'));
    const by = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!.data.generatedBy?.at(-1);
    expect(by(x.nodeId)).toBe('codex/gpt-synthetic');
    expect(by(y.nodeId)).toBe('claude/claude-code/sonnet');
  });
});

describe('two unrelated lines on one runtime', () => {
  const f = fixture('same-runtime-two-targets');

  it('each task opens a session of its own', async () => {
    load(f);
    const x = await ask(task(f, 'X'));
    const y = await ask(task(f, 'Y'));
    expect(x.request.sessionPath).toBeUndefined();
    expect(y.request.sessionPath).toBeUndefined();
    expect(x.request.runtime).toBe('codex');
    expect(y.request.runtime).toBe('codex');
  });

  it('a standing approval given on one runtime is not offered to another runtime', async () => {
    load(f);
    const z = await ask(task(f, 'Z'));
    expect(z.request.runtime).toBe('claude-code');
    expect(z.request.allowRules ?? []).toEqual([]);
  });

  it('the line that was given a standing approval keeps it', async () => {
    load(f);
    const x = await ask(task(f, 'X'));
    expect(x.request.allowRules).toEqual(['codex:cmd:npm test']);
  });

  gap('[T28] a task does not inherit a standing approval given on an unrelated line', async () => {
    load(f);
    const y = await ask(task(f, 'Y'));
    expect(y.request.allowRules ?? []).toEqual([]);
  });
});

describe('the global defaults change between two runs of a task', () => {
  const f = fixture('global-default-changed');

  it('a run takes the global effort as it is when the run is sent', async () => {
    load(f);
    const pinned = await ask(task(f, 'pinned'));
    expect(pinned.request.effort).toBe('high');
  });

  it('a pinned task keeps its model when the toolbar\'s pick changes', async () => {
    load(f);
    const pinned = await ask(task(f, 'pinned'));
    useUiStore.getState().setSelectedModel('claude/claude-code/sonnet');
    const again = await rerun(pinned);
    expect(again).toMatchObject({ runtime: 'codex', model: { provider: 'codex', id: 'gpt-synthetic' } });
  });

  gap('[T27] a task keeps the effort it ran with when the global effort changes', async () => {
    load(f);
    const pinned = await ask(task(f, 'pinned'));
    useUiStore.getState().setAgentEffort('low');
    const again = await rerun(pinned);
    expect(again.effort).toBe('high');
  });

  gap('[T26] a task on an unpinned line keeps the model it was created with when the toolbar\'s pick changes', async () => {
    load(f);
    const following = await ask(task(f, 'following'));
    expect(following.request.runtime).toBe('codex');
    useUiStore.getState().setSelectedModel('claude/claude-code/sonnet');
    const again = await rerun(following);
    expect(again.runtime).toBe('codex');
  });
});

describe('two runs in flight at once', () => {
  const f = fixture('two-targets');
  const responseOf = (question: string) => useStore.getState().nodes.find((n) => n.data.question === question)!.data.response;

  /** Start both tasks and wait until both runs have reached the bridge. */
  async function startBoth() {
    load(f, true);
    const x = task(f, 'X');
    const y = task(f, 'Y');
    const done = [useStore.getState().addQuestion(x.question, { parentId: x.parentNodeId }), useStore.getState().addQuestion(y.question, { parentId: y.parentNodeId })];
    await vi.waitFor(() => expect(desktop.runs.length).toBe(2));
    const runOf = (t: FixtureTask) => desktop.runIds[desktop.runs.findIndex((r) => r.prompt.endsWith(t.question))];
    return { x, y, runX: runOf(x), runY: runOf(y), done };
  }

  it('each node receives only its own run\'s stream, however the events interleave', async () => {
    const { x, y, runX, runY, done } = await startBoth();
    desktop.say(runY, 'Y_STREAM_1 ');
    desktop.say(runX, 'X_STREAM_1 ');
    desktop.say(runY, 'Y_STREAM_2');
    desktop.say(runX, 'X_STREAM_2');
    desktop.end(runY, 'Y_STREAM_1 Y_STREAM_2');
    desktop.end(runX, 'X_STREAM_1 X_STREAM_2');
    await Promise.all(done);
    expect(responseOf(x.question)).toBe('X_STREAM_1 X_STREAM_2');
    expect(responseOf(y.question)).toBe('Y_STREAM_1 Y_STREAM_2');
  });

  it('one run ending leaves the other running, and a late event for the ended run changes nothing', async () => {
    const { x, y, runX, runY, done } = await startBoth();
    desktop.end(runX, 'X_DONE');
    await done[0];
    expect(responseOf(x.question)).toBe('X_DONE');
    expect(useStore.getState().nodes.find((n) => n.data.question === y.question)!.data.isLoading).toBe(true);
    desktop.say(runX, ' LATE_X_EVENT');
    desktop.emit('no-such-run', { type: 'run_end', how: 'end', text: 'STRAY' });
    desktop.end(runY, 'Y_DONE');
    await done[1];
    expect(responseOf(x.question)).toBe('X_DONE');
    expect(responseOf(y.question)).toBe('Y_DONE');
  });
});

// How a pin that cannot be reached is handled today: remapped to a model of
// the same name under another provider, or dropped in favor of the toolbar's
// pick. The app says so in a notice after the fact; it does not ask first.
// The plan (R25) wants a confirmation before material goes to another
// provider; that change belongs to T26 and T30.
describe('a pinned model that is not available here', () => {
  const model = (id: string) => ({ id, name: id, provider: id.split('/')[0], vision: false });

  it('is remapped to the same model name under another provider when one exists', () => {
    expect(reconcileModelId('provider-a/model-synthetic', [model('provider-b/model-synthetic')])).toBe('provider-b/model-synthetic');
  });

  it('is dropped when nothing of that name exists', () => {
    expect(reconcileModelId('provider-a/model-synthetic', [model('provider-b/other-model')])).toBeNull();
  });
});
