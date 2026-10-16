// A capturing stand-in for the desktop shell's agent bridge
// (window.desktopAgents). It runs nothing: it records what the canvas hands
// to a runtime — the run request with its prompt, and every material file
// written for the agent to read. Materials are written as the shell writes
// them (runtime/execution/materialize.cjs), from the run's envelope: a
// workspace file from its snapshot, a passage as the passage, what the
// canvas holds as it was handed over; the hashes are not checked here (the
// stand-in workspace's are not SHA-256), the shell's own tests do that. By
// default a run ends at once; with `hold` it stays open and the test sends
// its events by hand.
import { locatePassage } from '../../src/lib/context/resource-resolver';
import type { ResolvedInput } from '../../src/lib/context/contracts';

type MaterialFile = { name: string; content: string; encoding?: 'utf8' | 'base64' };
type AgentEvent = Record<string, unknown> & { type: string };
type AgentEventPayload = { runId: string; event: AgentEvent };

export interface FakeDesktop {
  /** every run request, oldest first */
  runs: DesktopAgentRunRequest[];
  /** the id each run was given, parallel to `runs` */
  runIds: string[];
  /** every run's materials as written, oldest first */
  materials: { cwd: string; runId: string; files: MaterialFile[] }[];
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
  const materials: { cwd: string; runId: string; files: MaterialFile[] }[] = [];
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
    materialize: async (cwd, envelope, provided) => {
      const files: MaterialFile[] = [];
      const entries: MaterialsReceiptEntry[] = [];
      for (const input of envelope.inputs as ResolvedInput[]) {
        let text: string | null = null;
        let base64: string | null = null;
        if (input.source.kind === 'attachment') {
          base64 = provided[input.inputId] ?? null;
          if (base64 === null) return { ok: false, code: 'unavailable', message: 'what the canvas holds of this input was not given', inputId: input.inputId };
          if (input.payload !== 'image') { text = new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))); base64 = null; }
        } else if (input.source.kind === 'resource') {
          const kept = await window.desktopWorkspace!.readSnapshot('', input.snapshotId).catch(() => null);
          if (!kept) return { ok: false, code: 'lost', message: 'the snapshot the run names is not kept', inputId: input.inputId };
          if (kept.representation === 'text') text = kept.payload as string;
          else base64 = btoa(String.fromCharCode(...(kept.payload as Uint8Array)));
        }
        const selector = input.source.kind === 'resource' ? input.source.ref.selector : null;
        let part: 'whole' | 'passage' = 'whole';
        if (selector?.kind === 'text' && text !== null) {
          const at = locatePassage(text, selector);
          if (typeof at === 'string') return { ok: false, code: at === 'ambiguous' ? 'selection-ambiguous' : 'selection-lost', message: 'the passage', inputId: input.inputId };
          text = text.slice(at.from, at.to);
          part = 'passage';
        }
        const path = `materials/${input.inputId}-${input.displayName.split(/[\\/]/).pop() || 'input'}`;
        files.push(text !== null ? { name: path, content: text } : { name: path, content: base64 ?? '', encoding: 'base64' });
        entries.push({ inputId: input.inputId, path, displayName: input.displayName, part, bytes: 0, sourceHash: input.contentHash, writtenHash: '', permission: 'read' });
      }
      materials.push({ cwd, runId: envelope.runId, files });
      return { ok: true, dir: `.thoughtdag/runs/${envelope.runId}`, receipt: { runId: envelope.runId, manifest: 'materials/manifest.json', entries, totalBytes: 0 } };
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
