// A capturing stand-in for the desktop shell's agent bridge
// (window.desktopAgents). It runs nothing: it records what the canvas hands
// to a runtime — the run request with its prompt, and every material file
// written for the agent to read. By default a run ends at once; with `hold`
// it stays open and the test sends its events by hand.

type MaterialFile = { name: string; content: string; encoding?: 'utf8' | 'base64' };
type AgentEvent = Record<string, unknown> & { type: string };
type AgentEventPayload = { runId: string; event: AgentEvent };

export interface FakeDesktop {
  /** every run request, oldest first */
  runs: DesktopAgentRunRequest[];
  /** the id each run was given, parallel to `runs` */
  runIds: string[];
  /** every writeMaterials call, oldest first */
  materials: { cwd: string; files: MaterialFile[] }[];
  /** the text of every file the canvas wrote for the agent to read */
  readableFileContents(): string[];
  /** send one event as the shell would, to whoever is listening */
  emit(runId: string, event: AgentEvent): void;
  /** a text delta, then nothing more */
  say(runId: string, text: string): void;
  /** end a held run with its final text */
  end(runId: string, text: string): void;
  uninstall(): void;
}

// agent-runtime subscribes to the bridge once per module instance, so the
// listener outlives any one install: keep it here and hand it to each fake.
let listener: ((payload: AgentEventPayload) => void) | null = null;
let runCount = 0;

export function installFakeDesktop(options: { workspace?: string; reply?: string; hold?: boolean } = {}): FakeDesktop {
  const workspace = options.workspace ?? '/synthetic/workspace';
  const reply = options.reply ?? 'synthetic answer';
  const runs: DesktopAgentRunRequest[] = [];
  const runIds: string[] = [];
  const materials: { cwd: string; files: MaterialFile[] }[] = [];
  const emit = (runId: string, event: AgentEvent) => listener?.({ runId, event });

  const bridge: DesktopAgentsBridge = {
    available: async () => ({ pi: null, codex: '/synthetic/bin/codex', 'claude-code': '/synthetic/bin/claude' }),
    models: async () => ({ installed: true, models: [], default: null }),
    run: async (request) => {
      runs.push(request);
      const runId = `fake-run-${++runCount}`;
      runIds.push(runId);
      // after the caller has registered its handler for this run id
      if (!options.hold) setTimeout(() => emit(runId, { type: 'run_end', how: 'end', text: reply }), 0);
      return runId;
    },
    abort: async () => true,
    workspace: async () => workspace,
    answer: async () => true,
    pickCwd: async () => null,
    guardWrite: async () => true,
    writeMaterials: async (cwd, files) => {
      materials.push({ cwd, files });
      return { dir: `${cwd}/.thoughtdag/materials`, written: files.map((f) => f.name) };
    },
    onEvent: (cb) => { listener = cb; },
  };

  const previous = window.desktopAgents;
  window.desktopAgents = bridge;

  return {
    runs,
    runIds,
    materials,
    readableFileContents: () => materials.flatMap((m) => m.files.map((f) => (f.encoding === 'base64' ? atob(f.content) : f.content))),
    emit,
    say: (runId, text) => emit(runId, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } }),
    end: (runId, text) => emit(runId, { type: 'run_end', how: 'end', text }),
    uninstall: () => { window.desktopAgents = previous; },
  };
}
