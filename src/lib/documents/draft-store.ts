// Where unsaved typing is kept so that it is not lost: in the workspace's
// own records, through the workspace door, one draft per file. A draft is
// what a crash, a closed view or a refused save leaves behind for the next
// time the file is opened. It is never sent to a model by default.

import { clearDraft, getDraft, putDraft } from '../workspace/client';
import type { ContentHash, DocumentDraft } from '../workspace/contracts';

export interface DraftStore {
  /** keep `text`, typed over the content `baseRevision`, as the file's one draft; `byHand` says it is not to be saved without the person saying so */
  put(fileId: string, text: string, baseRevision: ContentHash, more?: { byHand?: boolean }): Promise<void>;
  get(fileId: string): Promise<DocumentDraft | null>;
  clear(fileId: string): Promise<void>;
}

/** Drafts kept in the workspace the file is in. */
export const workspaceDrafts: DraftStore = {
  put: async (fileId, text, baseRevision, more) => { await putDraft(fileId, text, baseRevision, more); },
  get: (fileId) => getDraft(fileId),
  clear: async (fileId) => { await clearDraft(fileId); },
};
