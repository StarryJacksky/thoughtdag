// A reference to a file (or a part of one), made into what a run is given:
// the file as it is saved, frozen into a snapshot the run names, and the
// part the reference selects, found again by its own words. A run that
// cannot be given what it was wired to is not sent: a file that is lost, a
// document in conflict with its file or that could not be saved, a passage
// that stands twice now or no longer stands at all.

import type { ResourceRef, ResourceSelector } from '../workspace/contracts';
import { freezeFile, reconcileFile, WorkspaceError } from '../workspace/client';
import { documents } from '../documents/document-service';
import type { ResolvedInput } from './contracts';
import { digestOf } from './canonicalize';

export type BlockReason = 'lost' | 'conflict' | 'not-saved' | 'selection-ambiguous' | 'selection-lost' | 'too-large' | 'copy-out-of-date' | 'unavailable';

/** Why a run was not prepared: what it was wired to cannot be given as it is. */
export class RunBlocked extends Error {
  readonly reason: BlockReason;
  /** the node on the canvas that holds what could not be given */
  readonly nodeId: string | null;
  readonly fileId: string | null;
  constructor(reason: BlockReason, nodeId: string | null, fileId: string | null, message: string) {
    super(message);
    this.name = 'RunBlocked';
    this.reason = reason;
    this.nodeId = nodeId;
    this.fileId = fileId;
  }
}

/** A reference, frozen: the input, and what the run is given of it (its text, or its bytes). */
export interface ResolvedResource {
  input: ResolvedInput;
  text: string | null;
  bytes: Uint8Array | null;
}

/**
 * Where a passage stands in a text now, found by its words: the quote with
 * the words around it, else the quote alone. Two places that fit equally are
 * an ambiguity, not a guess.
 */
export function locatePassage(text: string, selector: Extract<ResourceSelector, { kind: 'text' }>): { from: number; to: number } | 'ambiguous' | 'lost' {
  const { quote, prefix, suffix } = selector;
  if (!quote) return 'lost';
  const all: number[] = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) all.push(at);
  if (all.length === 0) return 'lost';
  const inContext = all.filter((at) => text.slice(0, at).endsWith(prefix) && text.slice(at + quote.length).startsWith(suffix));
  const fits = inContext.length > 0 ? inContext : all;
  if (fits.length > 1) return 'ambiguous';
  return { from: fits[0], to: fits[0] + quote.length };
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Freeze what `ref` points at for a run. `nodeId` is the node that holds the
 * reference on the canvas (it is named when the run is refused); `reason`
 * says why the input is in the run.
 */
export async function resolveRef(ref: ResourceRef, { nodeId = null, reason, displayName }: { nodeId?: string | null; reason: string; displayName?: string }): Promise<ResolvedResource> {
  const fileId = ref.fileId;
  const blocked = (r: BlockReason, message: string) => new RunBlocked(r, nodeId, fileId, message);

  let record;
  try { record = await reconcileFile(fileId); } catch (e) {
    if (e instanceof WorkspaceError && (e.code === 'lost' || e.code === 'unknown-file' || e.code === 'not-found')) throw blocked('lost', 'the file is lost');
    throw blocked('unavailable', why(e));
  }
  if (record.status === 'missing' || record.status === 'ambiguous') throw blocked('lost', 'the file is lost');

  // what is typed into the file and not saved yet is what the person sees: it is saved first, and the run is given that
  const open = documents.documentOf(fileId);
  if (open) {
    const now = documents.get(open.documentId) ?? open;
    if (now.state === 'conflict') throw blocked('conflict', 'the document is in conflict with its file');
    if (now.state !== 'clean' && now.state !== 'readonly') {
      const saved = await documents.save(open.documentId);
      if (saved.status === 'conflict') throw blocked('conflict', 'the document is in conflict with its file');
      if (saved.status !== 'saved') throw blocked('not-saved', 'what is typed into the file could not be saved');
    }
  }

  let frozen;
  try { frozen = await freezeFile(fileId); } catch (e) {
    if (e instanceof WorkspaceError && e.code === 'lost') throw blocked('lost', 'the file is lost');
    if (e instanceof WorkspaceError && e.code === 'too-large') throw blocked('too-large', 'the file is too large to be sent');
    throw blocked('unavailable', why(e));
  }
  // the file changed between the save and the freeze: what the document shows is not what was frozen
  if (open) {
    const now = documents.get(open.documentId);
    if (now && now.state !== 'readonly' && now.sourceContentHash !== frozen.contentHash) throw blocked('conflict', 'the file changed while it was being frozen');
  }

  const fileText = frozen.representation === 'text' ? frozen.payload as string : null;
  const fileBytes = frozen.representation === 'bytes' ? frozen.payload as Uint8Array : null;
  let text = fileText;
  if (ref.selector.kind === 'text') {
    if (fileText === null) throw blocked('selection-lost', 'a passage was selected in a file that is not text');
    const at = locatePassage(fileText, ref.selector);
    if (at === 'ambiguous') throw blocked('selection-ambiguous', 'the passage stands more than once in the file now');
    if (at === 'lost') throw blocked('selection-lost', 'the passage is no longer in the file');
    text = fileText.slice(at.from, at.to);
  }

  const contentHash = frozen.contentHash;
  // the same reference to the same content is the same input, prepared any number of times
  const inputId = `in_${(await digestOf({ fileId, selector: ref.selector, contentHash })).slice('sha256:'.length, 'sha256:'.length + 16)}`;
  const given = text !== null ? new TextEncoder().encode(text) : fileBytes ?? new Uint8Array();
  const input: ResolvedInput = {
    inputId,
    source: { kind: 'resource', ref: { ...ref, version: { kind: 'snapshot', snapshotId: frozen.snapshotId ?? `unkept:${contentHash.slice('sha256:'.length)}` } } },
    snapshotId: frozen.snapshotId ?? `unkept:${contentHash.slice('sha256:'.length)}`,
    // over the exact content of the file as frozen; a passage is told apart by its selector, beside it
    contentHash,
    payload: ref.payload,
    displayName: displayName || (record.relativePath ?? '').split('/').pop() || fileId,
    size: { bytes: given.byteLength, ...(text !== null ? { textChars: text.length } : {}) },
    reason,
  };
  return { input, text, bytes: fileBytes };
}
