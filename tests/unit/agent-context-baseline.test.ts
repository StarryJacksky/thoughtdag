import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../src/store';
import { useProjects } from '../../src/store/projects';
import { agentCallStream, agentOutbound, type AgentRoute } from '../../src/lib/agents/agent-runtime';
import { fixture, type FixtureGraph, type ResearchFixture } from '../fixtures/research';
import { composeRequest } from '../helpers/compose-request';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';
import { gap } from '../helpers/gap';

// What an agent runtime is handed today, measured at the desktop bridge:
// the route, the prompt, and the files written for it to read. `it` cases
// are behavior that holds and must keep holding; `gap` cases state what the
// research-workspace plan requires and today's code does not do.

let desktop: FakeDesktop;

beforeEach(() => { desktop = installFakeDesktop(); });
afterEach(() => {
  desktop.uninstall();
  useStore.setState({ nodes: [], edges: [] });
  useProjects.setState({ projects: [], activeId: null, switching: false });
});

interface Handed {
  route: AgentRoute | undefined;
  prompt: string;
  /** everything the agent could read from disk, joined */
  readable: string;
}

/** Put the fixture's canvas in the store and generate its target node against the fake bridge. */
async function generate(f: ResearchFixture, graph: FixtureGraph = f.graph): Promise<Handed> {
  useStore.setState({ nodes: graph.nodes, edges: graph.edges });
  const history = f.nativeHistory;
  useProjects.setState({
    projects: [{
      id: 'fixture-canvas', name: f.name, createdAt: 0, updatedAt: 0,
      agentCwd: f.policy.cwd,
      ...(history ? { sourceSession: { sessionId: history.sessionId, runner: history.runner, importedCount: history.importedCount, tailNodeId: history.tailNodeId } } : {}),
    }],
    activeId: 'fixture-canvas',
    switching: false,
  });
  const target = f.expected.targetNodeId;
  const route = await agentOutbound(f.policy.model, target);
  const { messages, images } = composeRequest(target, graph.nodes, graph.edges);
  await agentCallStream(messages, () => {}, undefined, images, undefined, f.policy.model, route, target);
  const run = desktop.runs.at(-1);
  if (!run) throw new Error('the fake bridge saw no run');
  return { route, prompt: run.prompt, readable: desktop.readableFileContents().join('\n') };
}

describe('a question off the tail of a mirrored session', () => {
  const f = fixture('single-parent-edited-ancestor');
  const question = f.graph.nodes.find((n) => n.id === f.expected.targetNodeId)!.data.question;

  it('continues the session and sends only the question when nothing upstream changed', async () => {
    const handed = await generate(f, f.graph);
    expect(handed.route).toMatchObject({ continue: true, sessionPath: f.nativeHistory!.sessionFile, cwd: f.policy.cwd });
    expect(handed.prompt).toBe(question);
    expect(desktop.materials).toEqual([]);
  });

  it('opens a fresh session carrying the compiled context when a second edge is wired in', async () => {
    const extra = fixture('excluded-attachment').graph.nodes[0];
    const graph: FixtureGraph = {
      nodes: [...f.graph.nodes, { ...extra, id: 'side' }],
      edges: [...f.graph.edges, { id: 'side->n3', source: 'side', target: 'n3', data: { isCrossLink: true } }],
    };
    const handed = await generate(f, graph);
    expect(handed.route?.continue).toBeFalsy();
    expect(handed.prompt).toContain('ORIGINAL_UPSTREAM_A1');
    expect(handed.prompt.endsWith(question)).toBe(true);
  });

  gap('[T14] opens a fresh session when an ancestor answer was edited on the canvas', async () => {
    const handed = await generate(f, f.edited);
    expect(handed.route?.continue).toBeFalsy();
  });

  gap('[T14] hands the agent the edited ancestor text, not only the question', async () => {
    const handed = await generate(f, f.edited);
    for (const marker of f.expected.promptContains ?? []) expect(handed.prompt).toContain(marker);
  });
});

describe('an attachment excluded on the asking node', () => {
  const f = fixture('excluded-attachment');

  it('stays out of the prompt while the kept one is sent', async () => {
    const handed = await generate(f);
    expect(handed.route?.continue).toBeFalsy();
    for (const marker of f.expected.promptContains ?? []) expect(handed.prompt).toContain(marker);
    for (const marker of f.expected.promptExcludes ?? []) expect(handed.prompt).not.toContain(marker);
  });

  it('leaves the kept attachment readable on disk', async () => {
    const handed = await generate(f);
    for (const marker of f.expected.readableContains ?? []) expect(handed.readable).toContain(marker);
  });

  gap('[T12] stays out of the files written for the agent to read', async () => {
    const handed = await generate(f);
    for (const marker of f.expected.readableExcludes ?? []) expect(handed.readable).not.toContain(marker);
  });
});

describe('two different files with one name', () => {
  it('both reach the prompt when their contents differ from the start', async () => {
    const f = fixture('same-name-different-dirs');
    const handed = await generate(f);
    for (const marker of f.expected.promptContains ?? []) expect(handed.prompt).toContain(marker);
  });

  gap('[T12] both are written for the agent to read', async () => {
    const f = fixture('same-name-different-dirs');
    const handed = await generate(f);
    for (const marker of f.expected.readableContains ?? []) expect(handed.readable).toContain(marker);
  });

  gap('[T11] both reach the prompt when they share a size and their first hundred characters', async () => {
    const f = fixture('same-name-same-prefix');
    const handed = await generate(f);
    for (const marker of f.expected.promptContains ?? []) expect(handed.prompt).toContain(marker);
  });
});
