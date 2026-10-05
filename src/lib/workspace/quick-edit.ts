// Typing into a workspace file from its node: read the text with the
// revision it was read at, and save against that revision, so a save never
// lands on top of a change made elsewhere without the person being told.
// The text shown uses plain line feeds (a text box would turn them into
// that anyway); what is written back keeps the file's own line endings.
// The file's byte-order mark is the shell's to keep, and it does.

import { newOperationId, readText, saveText } from './client';
import type { ContentHash, SaveResult, TextRevision } from './contracts';

export interface EditSession {
  fileId: string;
  /** the revision the text was read at, or last saved as */
  base: ContentHash;
  /** the text as it was read or last saved, in the form it is shown */
  loaded: string;
  encoding: string;
  newline: TextRevision['newline'];
}

const shown = (text: string): string => text.replace(/\r\n/g, '\n');

/** The text to write for a draft: the file's own line endings put back. */
export function toDisk(session: Pick<EditSession, 'newline'>, draft: string): string {
  return session.newline === 'crlf' ? shown(draft).replace(/\n/g, '\r\n') : draft;
}

/** Read a file for typing into. Rejects for a file that is not text. */
export async function openEdit(fileId: string): Promise<EditSession> {
  const read = await readText(fileId);
  return { fileId, base: read.revision, loaded: shown(read.text), encoding: read.encoding, newline: read.newline };
}

/**
 * Save a draft against a revision: the one the session holds, or, when the
 * person chose to overwrite a change made elsewhere, the one that change
 * left. Resolves with the workspace's answer and the session to go on with;
 * the session moves on only when the save was confirmed.
 */
export async function saveEdit(session: EditSession, draft: string, against: ContentHash = session.base): Promise<{ session: EditSession; result: SaveResult }> {
  const result = await saveText(session.fileId, against, toDisk(session, draft), newOperationId());
  return { session: result.status === 'saved' ? { ...session, base: result.revision, loaded: draft } : session, result };
}
