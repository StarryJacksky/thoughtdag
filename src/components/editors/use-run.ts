import { useCallback, useEffect, useRef, useState } from 'react';
import { documents } from '../../lib/documents/document-service';
import { canRun, onRun, prepareRuns, runFile, runTools, stopRun, type RunEvent, type RunTools } from '../../lib/workspace/run';
import { toast } from '../../lib/ui-store';
import { fmt, t } from '../../i18n';

export interface RunState {
  /** what would run the file, once known; null while it is being asked or when files are not run here */
  tools: RunTools | null;
  runId: string | null;
  command: string;
  lines: { stream: 'stdout' | 'stderr' | 'note'; text: string }[];
  status: 'idle' | 'running' | 'ok' | 'failed' | 'stopped' | 'unavailable';
  code: number | null;
  ms: number | null;
}
const IDLE: RunState = { tools: null, runId: null, command: '', lines: [], status: 'idle', code: null, ms: null };
/** Output kept on screen, at most: older lines go first. */
const MAX_LINES = 5000;

/**
 * Running the file of a document from its editor: what would run it, a run
 * started (after what was typed is saved: what runs is what is on screen),
 * its output as it comes, and stopping it. `onOutput` is told of a file the
 * run made (a LaTeX source's PDF).
 */
export function useRun(documentId: string, onOutput?: (fileId: string) => void) {
  const [state, setState] = useState<RunState>(IDLE);
  const fileId = documents.get(documentId)?.fileId ?? '';
  const stop = useRef<(() => void) | null>(null);
  const output = useRef(onOutput);
  useEffect(() => { output.current = onOutput; }, [onOutput]);

  useEffect(() => {
    if (!fileId || !canRun()) return;
    let here = true;
    void runTools(fileId).then((tools) => { if (here) setState((s) => ({ ...s, tools })); }).catch(() => {});
    return () => { here = false; stop.current?.(); };
  }, [fileId]);

  const handle = useCallback((event: RunEvent) => {
    setState((s) => {
      if (event.runId !== s.runId) return s;
      switch (event.type) {
        case 'start': return { ...s, command: event.command };
        case 'step': return { ...s, lines: [...s.lines, { stream: 'note' as const, text: `$ ${event.command}\n` }].slice(-MAX_LINES) };
        case 'output': return { ...s, lines: [...s.lines, { stream: event.stream, text: event.text }].slice(-MAX_LINES) };
        case 'end': return { ...s, status: event.status, code: event.code, ms: event.ms, lines: event.missing?.length ? [...s.lines, { stream: 'stderr' as const, text: fmt(t('run.missing'), { tools: event.missing.join(', ') }) + '\n' }] : event.reason ? [...s.lines, { stream: 'stderr' as const, text: event.reason + '\n' }] : s.lines };
        default: return s;
      }
    });
    if (event.type === 'end') {
      stop.current?.();
      stop.current = null;
      if (event.status === 'ok' && event.output) output.current?.(event.output);
    }
  }, []);

  const run = useCallback(async () => {
    if (!fileId) return;
    // what runs is what is on the screen: typing not yet saved is saved first
    const doc = documents.get(documentId);
    if (doc && doc.state !== 'clean' && doc.state !== 'readonly') {
      const saved = await documents.save(documentId);
      if (saved.status !== 'saved') { toast('error', t('run.notSaved')); return; }
    }
    prepareRuns();
    try {
      const runId = await runFile(fileId);
      stop.current?.();
      setState((s) => ({ ...s, runId, command: '', lines: [], status: 'running', code: null, ms: null }));
      stop.current = onRun(runId, handle);
    } catch (e) {
      toast('error', fmt(t('workspace.failed'), { why: e instanceof Error ? e.message : String(e) }));
    }
  }, [documentId, fileId, handle]);

  const halt = useCallback(() => { if (state.runId) void stopRun(state.runId).catch(() => {}); }, [state.runId]);
  const clear = useCallback(() => setState((s) => ({ ...s, lines: [], status: s.status === 'running' ? 'running' : 'idle', command: s.status === 'running' ? s.command : '' })), []);

  return { state, run, halt, clear, runnable: !!state.tools?.kind };
}
