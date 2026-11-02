import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventLedger } from '../../src/lib/agents/event-ledger';
import { reconcileRun, transitionRun, type RunStep } from '../../src/lib/agents/run-state';
import { createTarget, newTask, templateFor } from '../../src/lib/agents/targets';
import type { RunState } from '../../src/lib/context/contracts';
import { useUiStore } from '../../src/lib/ui-store';
import { recheckAgents, setModelsCache } from '../../src/lib/use-models';
import { useStore } from '../../src/store';
import { bootProjects, useProjects } from '../../src/store/projects';
import { installFakeDesktop, type FakeDesktop } from '../helpers/fake-desktop';

// What happens to a run between being asked for and ending (T17): events that come
// before anyone is listening, or twice, or late; a request whose receipt never came,
// which is looked up and not sent again. On a stand-in for the desktop shell: what is
// checked is what the page does with what it is told.

describe('[T17] a run\'s state', () => {
  const path = (...steps: RunStep[]) => steps.reduce<RunState>((state, step) => transitionRun(state, step), 'prepared');
  it('[T17] a run that goes well', () => {
    expect(path({ kind: 'submitting' })).toBe('starting');
    expect(path({ kind: 'submitting' }, { kind: 'accepted' })).toBe('running');
    expect(path({ kind: 'submitting' }, { kind: 'accepted' }, { kind: 'asked' })).toBe('awaiting-approval');
    expect(path({ kind: 'submitting' }, { kind: 'accepted' }, { kind: 'asked' }, { kind: 'answered', open: 0 })).toBe('running');
    expect(path({ kind: 'submitting' }, { kind: 'accepted' }, { kind: 'ended', how: 'end' })).toBe('completed');
  });
  it('[T17] two questions: it waits until both are answered', () => {
    expect(path({ kind: 'submitting' }, { kind: 'accepted' }, { kind: 'asked' }, { kind: 'asked' }, { kind: 'answered', open: 1 })).toBe('awaiting-approval');
  });
  it('[T17] stopped, failed, and a receipt that never came', () => {
    expect(path({ kind: 'submitting' }, { kind: 'accepted' }, { kind: 'stopping' })).toBe('cancelling');
    expect(path({ kind: 'submitting' }, { kind: 'accepted' }, { kind: 'stopping' }, { kind: 'ended', how: 'aborted' })).toBe('cancelled');
    expect(path({ kind: 'submitting' }, { kind: 'accepted' }, { kind: 'ended', how: 'error' })).toBe('failed');
    expect(path({ kind: 'submitting' }, { kind: 'no-receipt' })).toBe('unknown');
  });
  it('[T17] what has ended stays ended, whatever comes late', () => {
    for (const end of ['completed', 'failed', 'cancelled'] as RunState[]) {
      for (const step of [{ kind: 'accepted' }, { kind: 'asked' }, { kind: 'stopping' }, { kind: 'no-receipt' }, { kind: 'ended', how: 'end' }] as RunStep[]) expect(transitionRun(end, step)).toBe(end);
    }
  });
  it('[T17] unknown is left only by something that says how it went', () => {
    expect(transitionRun('unknown', { kind: 'submitting' })).toBe('unknown');
    expect(transitionRun('unknown', { kind: 'asked' })).toBe('unknown');
    expect(transitionRun('unknown', { kind: 'ended', how: 'end' })).toBe('completed');
  });
  it('[T17] an end that comes before a receipt still counts', () => {
    expect(path({ kind: 'submitting' }, { kind: 'ended', how: 'end' })).toBe('completed');
  });
});

describe('[T17] looking up a run whose end was not recorded', () => {
  const record = (state: RunState) => ({ runId: 'run_1', state, nativeBinding: { runtime: 'codex', sessionId: 's1', hostRunId: 'host-1' } });
  it('[T17] what has ended is not asked about', async () => {
    const eventsSince = vi.fn();
    expect(await reconcileRun(record('completed') as never, eventsSince)).toBe('completed');
    expect(eventsSince).not.toHaveBeenCalled();
  });
  it('[T17] the host has it under way: under way', async () => {
    expect(await reconcileRun(record('running') as never, async () => ({ state: 'running', events: [], complete: true }))).toBe('running');
  });
  it('[T17] the host saw it end, and how', async () => {
    const said = (how: string) => async () => ({ state: 'ended' as const, events: [{ type: 'run_end', how, seq: 3 }], complete: true });
    expect(await reconcileRun(record('running') as never, said('end'))).toBe('completed');
    expect(await reconcileRun(record('running') as never, said('aborted'))).toBe('cancelled');
    expect(await reconcileRun(record('running') as never, said('error'))).toBe('failed');
  });
  it('[T17] the host knows nothing of it, cannot say, or there is no host: unknown', async () => {
    expect(await reconcileRun(record('running') as never, async () => ({ state: 'unknown', events: [], complete: false }))).toBe('unknown');
    expect(await reconcileRun(record('starting') as never, async () => { throw new Error('gone'); })).toBe('unknown');
    expect(await reconcileRun(record('running') as never, undefined)).toBe('unknown');
    expect(await reconcileRun({ ...record('running'), nativeBinding: null } as never, async () => ({ state: 'running', events: [], complete: true }))).toBe('unknown');
  });
});

describe('[T17] the ledger of a run\'s events', () => {
  const told = (type: string, more: Record<string, unknown> = {}) => ({ type, ...more });
  it('[T17] what comes before anyone listens is kept, and told in order once someone does', () => {
    const ledger = createEventLedger();
    expect(ledger.ingestEvent('a', told('session', { seq: 1 }))).toBe('held');
    expect(ledger.ingestEvent('a', told('message_update', { seq: 2 }))).toBe('held');
    const heard: unknown[] = [];
    ledger.register('a', (e) => heard.push(e.seq));
    expect(heard).toEqual([1, 2]);
    expect(ledger.ingestEvent('a', told('message_update', { seq: 3 }))).toBe('delivered');
    expect(heard).toEqual([1, 2, 3]);
  });
  it('[T17] the same event twice is told once', () => {
    const ledger = createEventLedger();
    const heard: unknown[] = [];
    ledger.register('a', (e) => heard.push(e.seq));
    ledger.ingestEvent('a', told('message_update', { seq: 1 }));
    expect(ledger.ingestEvent('a', told('message_update', { seq: 1 }))).toBe('duplicate');
    expect(heard).toEqual([1]);
  });
  it('[T17] with no numbers: a tool call and a question are still told once, by their own ids', () => {
    const ledger = createEventLedger();
    const heard: string[] = [];
    ledger.register('a', (e) => heard.push(e.type));
    for (let i = 0; i < 2; i++) {
      ledger.ingestEvent('a', told('tool_execution_start', { toolCallId: 't1' }));
      ledger.ingestEvent('a', told('tool_execution_end', { toolCallId: 't1' }));
      ledger.ingestEvent('a', told('question', { id: 'q1' }));
      ledger.ingestEvent('a', told('question_answered', { id: 'q1' }));
    }
    expect(heard).toEqual(['tool_execution_start', 'tool_execution_end', 'question', 'question_answered']);
  });
  it('[T17] two runs are not mixed up, whatever their ids inside', () => {
    const ledger = createEventLedger();
    const heard: string[] = [];
    ledger.register('a', () => heard.push('a'));
    ledger.register('b', () => heard.push('b'));
    ledger.ingestEvent('a', told('question', { id: 'q1' }));
    ledger.ingestEvent('b', told('question', { id: 'q1' }));
    ledger.ingestEvent('b', told('message_update', { seq: 1 }));
    ledger.ingestEvent('a', told('message_update', { seq: 1 }));
    expect(heard).toEqual(['a', 'b', 'b', 'a']);
  });
  it('[T17] what comes after a run has ended reaches nobody, and is not kept', () => {
    const ledger = createEventLedger();
    const heard: string[] = [];
    ledger.register('a', (e) => heard.push(e.type));
    ledger.ingestEvent('a', told('run_end'));
    ledger.finish('a');
    expect(ledger.ingestEvent('a', told('message_update'))).toBe('ended');
    expect(heard).toEqual(['run_end']);
    expect(ledger.heldFor('a')).toBe(0);
  });
  it('[T17] what is kept for a run nobody claims is bounded', () => {
    const ledger = createEventLedger({ maxHeldEvents: 3, maxHeldRuns: 2 });
    for (let i = 1; i <= 5; i++) ledger.ingestEvent('a', told('message_update', { seq: i }));
    expect(ledger.heldFor('a')).toBe(3);
    ledger.ingestEvent('b', told('session', { seq: 1 }));
    ledger.ingestEvent('c', told('session', { seq: 1 }));
    expect(ledger.heldFor('a')).toBe(0);
    expect(ledger.heldFor('c')).toBe(1);
  });
});

const CANVAS = 'canvas-1';
const CODEX = 'codex/gpt-synthetic';
const node = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!;
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
function task(question: string) {
  const id = newTask(createTarget(templateFor(CODEX)), { x: 0, y: 600 });
  useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question, response: 'an earlier answer', responses: ['an earlier answer'] } } : n)) }));
  return id;
}

describe('[T17] a run on the canvas', () => {
  let desktop: FakeDesktop;
  beforeAll(() => bootProjects());
  beforeEach(async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
    desktop = installFakeDesktop({ hold: true });
    useStore.setState({ nodes: [], edges: [] });
    useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, agentCwd: '/synthetic/project' }], activeId: CANVAS, switching: false });
    useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false });
    setModelsCache({ models: [{ id: CODEX, name: 'synthetic', provider: '__agent__', vision: false }], default: null } as never);
    await recheckAgents();
    useUiStore.getState().setSelectedModel(CODEX);
  });
  afterEach(() => {
    desktop.uninstall();
    vi.unstubAllGlobals();
    setModelsCache({ models: [], default: null });
    useStore.setState({ nodes: [], edges: [] });
    useProjects.setState({ projects: [], activeId: null, switching: false });
    useUiStore.getState().setSelectedModel(null);
  });

  it('[T17] events that come before the shell has said the run\'s id are not lost', async () => {
    const bridge = window.desktopAgents!;
    bridge.run = async () => {
      desktop.emit('early-run', { type: 'session', seq: 1, sessionId: 'thread-1', threadId: 'thread-1', sessionFile: null, cwd: '/synthetic/project' });
      desktop.emit('early-run', { type: 'message_update', seq: 2, assistantMessageEvent: { type: 'text_delta', delta: 'EARLY_WORDS ' } });
      return 'early-run';
    };
    const id = task('Do this?');
    const running = useStore.getState().rerunNode(id, {});
    await vi.waitFor(() => expect(node(id).data.agentSession?.sessionId).toBe('thread-1'));
    desktop.emit('early-run', { type: 'message_update', seq: 3, assistantMessageEvent: { type: 'text_delta', delta: 'LATER_WORDS' } });
    desktop.emit('early-run', { type: 'run_end', seq: 4, how: 'end' });
    await running;
    expect(node(id).data.response).toBe('EARLY_WORDS LATER_WORDS');
  });

  it('[T17] the same words told twice are in the answer once', async () => {
    const id = task('Do this?');
    const running = useStore.getState().rerunNode(id, {});
    await vi.waitFor(() => expect(desktop.runIds).toHaveLength(1));
    await settled();
    const runId = desktop.runIds[0];
    const words = { type: 'message_update', seq: 1, assistantMessageEvent: { type: 'text_delta', delta: 'ONCE' } };
    desktop.emit(runId, words);
    desktop.emit(runId, words);
    desktop.emit(runId, { type: 'run_end', seq: 2, how: 'end' });
    await running;
    expect(node(id).data.response).toBe('ONCE');
  });

  it('[T17] a request whose receipt never came is not sent again, and the task says it is not known what became of it', async () => {
    const bridge = window.desktopAgents!;
    const run = vi.fn(async () => { throw new Error('the shell went away'); });
    bridge.run = run;
    const id = task('Do this?');
    await useStore.getState().rerunNode(id, {});
    await settled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(node(id).data.generationFailed).toBe(true);
    expect(useUiStore.getState().toasts.map((x) => x.message).join()).toMatch(/not known|不确定/);
  });
});

describe('[T17] a turn that goes on in a session the canvas mirrors', () => {
  let desktop: FakeDesktop;
  const SESSION = '11111111-2222-4333-8444-555555555555';
  beforeEach(async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
    desktop = installFakeDesktop({ hold: true });
    useUiStore.setState({ toasts: [], memoryEnabled: false, recallEnabled: false });
  });
  afterEach(() => {
    desktop.uninstall();
    vi.unstubAllGlobals();
    useStore.setState({ nodes: [], edges: [] });
    useProjects.setState({ projects: [], activeId: null, switching: false });
  });

  it('[T17] named twice while it runs, it is claimed once: the sweep is not told one turn is two', async () => {
    const { claimAgentTurn } = await import('../../src/lib/agents/agent-runtime');
    useStore.setState({ nodes: [{ id: 'n', position: { x: 0, y: 0 }, data: { question: 'q', response: '' } } as never], edges: [] });
    useProjects.setState({ projects: [{ id: CANVAS, name: 'canvas', createdAt: 0, updatedAt: 0, sourceSession: { sessionId: SESSION, runner: 'codex', importedCount: 3, tailNodeId: 't' } }], activeId: CANVAS, switching: false });
    await claimAgentTurn('codex', 'n', SESSION, '/synthetic/project');
    await claimAgentTurn('codex', 'n', SESSION, '/synthetic/project');
    expect(useProjects.getState().projects[0].sourceSession?.importedCount).toBe(4);
    expect(useProjects.getState().projects[0].sourceSession?.tailNodeId).toBe('n');
  });
});

describe('[T17] what a crash left in a folder', () => {
  const reported = (...runs: { runId: string; state: string; recorded: string; hostRunId?: string }[]) => ({ runs: runs.map(({ hostRunId, ...r }) => ({ ...r, nativeBinding: hostRunId ? { hostRunId } : null })) });
  it('[T17] a run still under way in the host is not one of them; one nobody can say anything of is; one that ended is not looked at', async () => {
    const { runsNotKnownToHaveEnded } = await import('../../src/lib/agents/run-state');
    const asked: string[] = [];
    const notKnown = await runsNotKnownToHaveEnded(reported(
      { runId: 'run_open', state: 'unknown', recorded: 'running', hostRunId: 'h-open' },
      { runId: 'run_lost', state: 'unknown', recorded: 'starting', hostRunId: 'h-lost' },
      { runId: 'run_none', state: 'unknown', recorded: 'running' },
      { runId: 'run_done', state: 'completed', recorded: 'completed', hostRunId: 'h-done' },
    ), async (id) => { asked.push(id); return { state: id === 'h-open' ? 'running' : 'unknown', events: [], complete: true }; });
    expect(notKnown).toEqual(['run_lost', 'run_none']);
    expect(asked).toEqual(['h-open', 'h-lost']);
  });
});
