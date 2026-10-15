// The canonical forms a run is digested in. One serialization (JSON with
// sorted keys, arrays in their order: order is meaning for context) and one
// hash (SHA-256), shared with the context bundle so that a digest computed
// anywhere in the app means the same thing.

import { canonicalStringify, sha256Hex } from '../context-bundle';
import type { ContentHash } from '../workspace/contracts';

export { canonicalStringify };

/** The SHA-256 of bytes, as a content hash. */
export async function hashBytes(bytes: Uint8Array): Promise<ContentHash> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The SHA-256 of text, as UTF-8. */
export const hashText = (text: string): Promise<ContentHash> => hashBytes(new TextEncoder().encode(text));

/** The SHA-256 of a value in its canonical serialization. */
export async function digestOf(value: unknown): Promise<ContentHash> {
  return `sha256:${await sha256Hex(canonicalStringify(value))}`;
}

/** The bytes a base64 string holds. */
export function bytesOfBase64(base64: string): Uint8Array {
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
