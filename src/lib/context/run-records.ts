// What a run leaves behind: its record, in each workspace whose files it
// read (runtime/execution/run-records.cjs keeps it there, beside the
// snapshots it names and apart from them), and a summary on the answer it
// wrote. A record is written when the run is prepared, before anything is
// sent, so that the snapshots it was given are held from then on; how it
// ended replaces it once it has. An answer keeps the summary of its own run,
// version by version, so an earlier answer still finds what it was given.

import type { RunSummary } from '../../types';
import { readSnapshot, recordRun as writeRecord } from '../workspace/client';
import type { SourceRead } from '../workspace/contracts';
import type { RunEnvelope, RunState, RuntimeSelection } from './contracts';
import { envelopePlaces } from './prepare-run';
import { useStore } from '../../store';

export interface RunRecord {
  schemaVersion: '1';
  runId: string;
  graphId: string;
  taskNodeId: string;
  targetId: string;
  targetRevision: string;
  inputDigest: string;
  executionDigest: string;
  graphRevision: string;
  runtime: RuntimeSelection;
  /** each input and where it is held: a snapshot here (snap_), no snapshot (unkept:, a read-only folder), or the canvas (node:) */
  inputs: { inputId: string; snapshotId: string; contentHash: string; fileId?: string }[];
  /** the runtime's own session the run went to, when it named one */
  nativeBinding: { runtime: string; sessionId: string | null } | null;
  /** the answer version it wrote, when it wrote one */
  output: { versionIndex: number; chars: number } | null;
  state: RunState;
  preparedAt: string;
  endedAt: string | null;
}

export interface RunOutcome {
  state: RunState;
  output?: { versionIndex: number; chars: number } | null;
  nativeBinding?: { runtime: string; sessionId: string | null } | null;
  preparedAt: string;
  endedAt?: string | null;
}

/** The record of a run of `envelope`, as it stands. */
export function recordRun(envelope: RunEnvelope, outcome: RunOutcome): RunRecord {
  return {
    schemaVersion: '1',
    runId: envelope.runId,
    graphId: envelope.graphId,
    taskNodeId: envelope.taskNodeId,
    targetId: envelope.targetId,
    targetRevision: envelope.targetRevision,
    inputDigest: envelope.inputDigest,
    executionDigest: envelope.executionDigest,
    graphRevision: envelope.graphRevision,
    runtime: envelope.runtime,
    inputs: envelope.inputs.map((i) => ({
      inputId: i.inputId, snapshotId: i.snapshotId, contentHash: i.contentHash,
      ...(i.source.kind === 'resource' ? { fileId: i.source.ref.fileId } : {}),
    })),
    nativeBinding: outcome.nativeBinding ?? null,
    output: outcome.output ?? null,
    state: outcome.state,
    preparedAt: outcome.preparedAt,
    endedAt: outcome.endedAt ?? null,
  };
}

/** What an answer keeps of the run that wrote it. */
export function summaryOf(envelope: RunEnvelope, imagesDropped = false, route?: RunSummary['route']): RunSummary {
  const places = envelopePlaces(envelope);
  return {
    runId: envelope.runId,
    inputDigest: envelope.inputDigest,
    executionDigest: envelope.executionDigest,
    graphRevision: envelope.graphRevision,
    inputs: envelope.inputs.map((i) => ({
      inputId: i.inputId, snapshotId: i.snapshotId, contentHash: i.contentHash,
      ...(i.source.kind === 'resource' ? { fileId: i.source.ref.fileId, name: i.displayName } : {}),
      ...(places[i.inputId] ? { workspaceId: places[i.inputId].workspaceId } : {}),
      ...(places[i.inputId]?.semanticHash ? { semanticHash: places[i.inputId].semanticHash } : {}),
    })),
    ...(imagesDropped ? { imagesDropped: true } : {}),
    ...(route ? { route } : {}),
  };
}

/**
 * Write a run's record in each workspace whose snapshots it names, with that workspace's inputs.
 * A run that read no file of any workspace has no record outside the canvas. A record that
 * cannot be written does not stop the run: the answer still carries its summary.
 */
export async function persistRun(envelope: RunEnvelope, record: RunRecord): Promise<void> {
  const places = envelopePlaces(envelope);
  const byWorkspace = new Map<string, RunRecord['inputs']>();
  for (const input of record.inputs) {
    const workspaceId = places[input.inputId]?.workspaceId;
    if (!workspaceId || !input.snapshotId.startsWith('snap_')) continue;
    byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), input]);
  }
  await Promise.all([...byWorkspace].map(([workspaceId, inputs]) => writeRecord(workspaceId, { ...record, inputs }).catch(() => undefined)));
}

/** One input an answer version was given, and how to read it back as it was then. */
export interface FrozenInputOfVersion {
  inputId: string;
  fileId: string;
  name: string;
  snapshotId: string;
  read(): Promise<SourceRead>;
}

/**
 * The files an answer version of a node was given, each readable as it was when the run read it:
 * the snapshots its run named. A version written before runs were recorded has none, and so
 * does an input that was held on the canvas or in a folder opened read-only.
 */
export function snapshotsOfVersion(nodeId: string, versionIndex: number): FrozenInputOfVersion[] {
  const node = useStore.getState().nodes.find((n) => n.id === nodeId);
  const run = node?.data.runs?.[versionIndex];
  if (!run) return [];
  return run.inputs
    .filter((i): i is typeof i & { fileId: string; workspaceId: string } => !!i.fileId && !!i.workspaceId && i.snapshotId.startsWith('snap_'))
    .map((i) => ({ inputId: i.inputId, fileId: i.fileId, name: i.name ?? i.fileId, snapshotId: i.snapshotId, read: () => readSnapshot(i.workspaceId, i.snapshotId) }));
}

