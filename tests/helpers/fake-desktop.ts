// A capturing stand-in for the desktop shell's agent bridge
// (window.desktopAgents). It runs nothing: it records what the canvas hands
// to a runtime — the run request with its prompt, and every material file
// written for the agent to read — and ends the run at once.

type MaterialFile = { name: string; content: string; encoding?: 'utf8' | 'base64' };
type AgentEventPayload = { runId: string; event: Record<string, unknown> & { type: string } };

export interface FakeDesktop {
  /** every run request, oldest first */
  runs: DesktopAgentRunRequest[];
  /** every writeMaterials call, oldest first */
  materials: { cwd: string; files: MaterialFile[] }[];
  /** the text of every file the canvas wrote for the agent to read */
  readableFileContents(): string[];
  uninstall(): void;
}

// agent-runtime subscribes to the bridge once per module instance, so the
// listener outlives any one install: keep it here and hand it to each fake.
let listener: ((payload: AgentEventPayload) => void) | null = null;
let runCount = 0;

export function installFakeDesktop(options: { workspace?: string; reply?: string } = {}): FakeDesktop {
  const workspace = options.workspace ?? '/synthetic/workspace';
  const reply = options.reply ?? 'synthetic answer';
  const runs: DesktopAgentRunRequest[] = [];
  const materials: { cwd: string; files: MaterialFile[] }[] = [];

  const bridge: DesktopAgentsBridge = {
    available: async () => ({ pi: null, codex: '/synthetic/bin/codex', 'claude-code': '/synthetic/bin/claude' }),
    models: async () => ({ installed: true, models: [], default: null }),
    run: async (request) => {
      runs.push(request);
      const runId = `fake-run-${++runCount}`;
      // after the caller has registered its handler for this run id
      setTimeout(() => listener?.({ runId, event: { type: 'run_end', how: 'end', text: reply } }), 0);
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
    materials,
    readableFileContents: () => materials.flatMap((m) => m.files.map((f) => (f.encoding === 'base64' ? atob(f.content) : f.content))),
    uninstall: () => { window.desktopAgents = previous; },
  };
}
