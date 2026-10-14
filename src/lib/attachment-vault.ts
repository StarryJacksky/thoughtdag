import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval';
import type { Attachment, ThoughtNode } from '../types';

// The attachment vault: bulky base64 payloads live in their own IndexedDB
// keys instead of inside node.data. Today that means PDF originals — they
// never enter model context (only extractedText does) and are read by
// exactly one consumer, the reader, which is already async. Keeping them
// out of the store shrinks the in-memory graph, every undo snapshot, and
// every persistence clone by the full weight of the PDFs.
//
// Images stay inline: their bytes ride the synchronous context-build path
// into vision requests, and they are typically an order of magnitude
// smaller than documents.
//
// Deleting a node does NOT delete its vault entries (undo must be able to
// resurrect them); orphans are swept by gcVault() at boot instead.

// A payload in the vault is never replaced. An attachment whose content
// changes (the copy of a workspace file) keeps its id and points at a new
// key (`vaultId`): whoever still holds the older attachment, an undo
// snapshot or another canvas that was copied from this one, reads the
// bytes that go with the text it has. Every payload put in is put under a
// key made from the payload itself (its SHA-256), never under the
// attachment's id: an export carries the id and not the key, and its
// import (or any other way the same attachment comes in again with other
// bytes) cannot reach bytes that another canvas reads under that id.
// Payloads put in before this read from their attachment's id, as before.

const KEY_PREFIX = 'att-content:';
const vaultKey = (attId: string) => `${KEY_PREFIX}${attId}`;
/** The vault key an attachment's payload is under. */
export const vaultIdOf = (att: Pick<Attachment, 'id' | 'vaultId'>): string => att.vaultId ?? att.id;

const shouldVault = (att: Attachment): boolean =>
  att.type === 'application/pdf' && !!att.content && !att.contentInVault;

/** The key a payload is kept under: its own hash, so that one key only ever holds one payload. */
async function keyOfPayload(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(content)));
    return `sha256-${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }
  // no digest here: a key nobody else has is as good, only not shared by equal payloads
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** Move a bulky payload into the vault; returns the lightened attachment.
    Non-PDF (and already-vaulted) attachments pass through unchanged. The
    payload goes under a key of its own (`vaultId`), never its id: see above. */
export async function internAttachment(att: Attachment): Promise<Attachment> {
  if (!shouldVault(att)) return att;
  const vaultId = await keyOfPayload(att.content);
  await idbSet(vaultKey(vaultId), att.content);
  return { ...att, content: '', contentInVault: true, vaultId };
}

/** The attachment's payload, wherever it lives. '' when the vault entry is
    missing (cleared storage) — callers surface their own error state. */
export async function loadAttachmentContent(att: Attachment): Promise<string> {
  if (!att.contentInVault) return att.content;
  return (await idbGet<string>(vaultKey(vaultIdOf(att)))) ?? '';
}

/** Exports and backups carry the FULL payload: a .thoughtdag.json must stay
    a complete, self-contained copy of the canvas. */
export async function inlineVaultedContent(nodes: ThoughtNode[]): Promise<ThoughtNode[]> {
  const out: ThoughtNode[] = [];
  for (const n of nodes) {
    const atts = n.data.attachments;
    if (!atts?.some((a) => a.contentInVault)) { out.push(n); continue; }
    const inlined: Attachment[] = [];
    for (const a of atts) {
      if (!a.contentInVault) { inlined.push(a); continue; }
      const content = await loadAttachmentContent(a);
      const rest = { ...a, content };
      delete rest.contentInVault;
      delete rest.vaultId;
      inlined.push(rest);
    }
    out.push({ ...n, data: { ...n.data, attachments: inlined } });
  }
  return out;
}

/** Imports strip bulky payloads back INTO the vault before the graph is
    stored; returns the lightened nodes. */
export async function internNodes(nodes: ThoughtNode[]): Promise<ThoughtNode[]> {
  const out: ThoughtNode[] = [];
  for (const n of nodes) {
    const atts = n.data.attachments;
    if (!atts?.some(shouldVault)) { out.push(n); continue; }
    const interned: Attachment[] = [];
    for (const a of atts) interned.push(await internAttachment(a));
    out.push({ ...n, data: { ...n.data, attachments: interned } });
  }
  return out;
}

/** Sweep vault entries no canvas references anymore. `referencedIds` must
    cover EVERY project's attachments, by the key each one's payload is
    under (`vaultIdOf`) — run it from boot, after the project list is known. */
export async function gcVault(referencedIds: Set<string>): Promise<number> {
  const all = (await idbKeys()) as string[];
  let swept = 0;
  for (const k of all) {
    if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) continue;
    if (referencedIds.has(k.slice(KEY_PREFIX.length))) continue;
    await idbDel(k);
    swept++;
  }
  return swept;
}
