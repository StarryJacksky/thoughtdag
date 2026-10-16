// What an agent run is given on disk: the inputs of its envelope, written
// by the shell into a directory of the run's own (runtime/execution/
// materialize.cjs), and the note its prompt carries saying where they are.
// Written from the envelope and from nothing else: what the person left out
// is not among its inputs, two files of one name are two inputs, a passage
// is given as the passage. The shell reads a workspace's files back from
// the snapshots the run names; what the canvas itself holds is handed over
// here, and the shell checks it against the envelope's hashes. A run whose
// inputs cannot be written as they were frozen is not sent.

import type { RunEnvelope } from './contracts';
import { RunBlocked, type BlockReason } from './resource-resolver';
import { envelopeHeld } from './prepare-run';

/** The shell's refusals, as the reasons a run is not sent. */
const REASONS: Record<string, BlockReason> = {
  'too-large': 'inputs-too-large',
  lost: 'lost',
  'hash-mismatch': 'copy-out-of-date',
  'selection-ambiguous': 'selection-ambiguous',
  'selection-lost': 'selection-lost',
  policy: 'policy',
};

/** The node on the canvas an input came from, and the file it is of. */
function whereFrom(envelope: RunEnvelope, inputId: string | null): { nodeId: string | null; fileId: string | null } {
  const input = inputId ? envelope.inputs.find((i) => i.inputId === inputId) : undefined;
  if (!input) return { nodeId: null, fileId: null };
  if (input.source.kind === 'attachment') return { nodeId: input.source.nodeId, fileId: null };
  const fileId = input.source.kind === 'resource' ? input.source.ref.fileId : null;
  return { nodeId: envelope.messages.find((m) => m.source.inputId === inputId)?.source.nodeId ?? null, fileId };
}

/** The note an agent's prompt carries: where each input is, and which part of what it is. */
function noteOf(dir: string, receipt: MaterialsReceipt): string {
  if (receipt.entries.length === 0) return '';
  const lines = receipt.entries.map((e) => `- ${dir}/${e.path}: ${e.part === 'passage' ? `a passage of ${e.displayName}` : e.displayName}`);
  return `The inputs of this run are also on disk, read-only, in your working directory under ${dir} (${dir}/${receipt.manifest} lists them):\n${lines.join('\n')}`;
}

/**
 * How an agent run of `envelope` gets its materials: written for the
 * working directory `cwd`, resolving with the note for the prompt, or ''
 * when the run has no inputs or there is no shell to write them. Throws
 * RunBlocked when the shell refuses: nothing was written, and the run is
 * not to be sent.
 */
export function materialsFor(envelope: RunEnvelope): (cwd: string) => Promise<string> {
  return async (cwd) => {
    const bridge = window.desktopAgents;
    if (!bridge?.materialize || envelope.inputs.length === 0) return '';
    const { runId, mode, runtime, policy, inputs } = envelope;
    const answer = await bridge.materialize(cwd, { runId, mode, runtime, policy, inputs }, envelopeHeld(envelope));
    if (!answer.ok) {
      const from = whereFrom(envelope, answer.inputId);
      throw new RunBlocked(REASONS[answer.code] ?? 'unavailable', from.nodeId, from.fileId, answer.message);
    }
    return noteOf(answer.dir, answer.receipt);
  };
}
