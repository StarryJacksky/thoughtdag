// Running a file with the tools installed on this machine, as the page
// sees it: what would run it, starting a run, stopping it, and the events
// of the runs this page started (see runtime/workspace/runner.cjs). Only
// the desktop app runs files.

import { WorkspaceError } from './client';

export interface RunTools {
  /** a script run by its interpreter, a program compiled then run, a LaTeX source compiled to a PDF; null: nothing runs this file */
  kind: 'script' | 'compiled' | 'latex' | null;
  label: string | null;
  needs: string[];
  /** what of that this machine lacks */
  missing: string[];
}

export type RunEvent =
  | { runId: string; type: 'start'; fileId: string; command: string }
  | { runId: string; type: 'step'; index: number; command: string }
  | { runId: string; type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { runId: string; type: 'end'; status: 'ok' | 'failed' | 'stopped' | 'unavailable'; code: number | null; ms: number; missing?: string[]; reason?: string; output?: string };

const bridge = () => {
  const b = typeof window !== 'undefined' ? window.desktopWorkspace : undefined;
  if (!b || typeof b.runFile !== 'function') throw new WorkspaceError('unavailable', 'files are run only in the desktop app');
  return b;
};
const unwrap = (e: unknown): never => {
  const message = e instanceof Error ? e.message : String(e);
  const found = /Error: ([a-z-]+): (.*)$/s.exec(message) ?? /^([a-z-]+): (.*)$/s.exec(message);
  throw found ? new WorkspaceError(found[1], found[2]) : new WorkspaceError('failed', message);
};

/** Whether files can be run here at all. */
export const canRun = (): boolean => typeof window !== 'undefined' && typeof window.desktopWorkspace?.runFile === 'function';

export async function runTools(fileId: string): Promise<RunTools> {
  try { return await bridge().runTools(fileId); } catch (e) { return unwrap(e); }
}
export async function runFile(fileId: string): Promise<string> {
  try { return await bridge().runFile(fileId); } catch (e) { return unwrap(e); }
}
export async function stopRun(runId: string): Promise<boolean> {
  try { return await bridge().stopRun(runId); } catch (e) { return unwrap(e); }
}

// one listener on the bridge, handing each event to whoever listens for that run
const listeners = new Map<string, Set<(event: RunEvent) => void>>();
const early = new Map<string, RunEvent[]>();
let listening = false;
function listen() {
  if (listening || !canRun()) return;
  listening = true;
  bridge().onRunEvent((event) => {
    const forRun = listeners.get(event.runId);
    if (forRun?.size) { for (const fn of [...forRun]) { try { fn(event); } catch { /* one listener's failure stops no other */ } } return; }
    // the run's id is learned only when runFile resolves: what arrives before that is kept for the listener that follows
    const kept = early.get(event.runId) ?? [];
    kept.push(event);
    early.set(event.runId, kept.slice(-500));
    if (early.size > 32) early.delete(early.keys().next().value as string);
  });
}

/** Hear the events of one run. What arrived before this was called is handed over first. Returns the function that stops it. */
export function onRun(runId: string, fn: (event: RunEvent) => void): () => void {
  listen();
  let set = listeners.get(runId);
  if (!set) { set = new Set(); listeners.set(runId, set); }
  set.add(fn);
  for (const event of early.get(runId) ?? []) fn(event);
  early.delete(runId);
  return () => { set!.delete(fn); if (set!.size === 0) listeners.delete(runId); };
}

/** Start listening before a run is started, so that none of its events are missed. */
export const prepareRuns = (): void => listen();
