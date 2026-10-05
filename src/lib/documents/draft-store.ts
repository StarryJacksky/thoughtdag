// Where unsaved typing is kept so that it is not lost: in the workspace's
// own records, through the workspace door, one draft per file. A draft is
// what a crash, a closed view or a refused save leaves behind for the next
// time the file is opened. It is never sent to a model by default.

import { clearDraft, getDraft, putDraft } from '../workspace/client';
import type { ContentHash, DocumentDraft } from '../workspace/contracts';

export interface DraftStore {
  /** keep `text`, typed over the content `baseRevision`, as the file's one draft */
  put(fileId: string, text: string, baseRevision: ContentHash): Promise<void>;
  get(fileId: string): Promise<DocumentDraft | null>;
  clear(fileId: string): Promise<void>;
}

/** Drafts kept in the workspace the file is in. */
export const workspaceDrafts: DraftStore = {
  put: async (fileId, text, baseRevision) => { await putDraft(fileId, text, baseRevision); },
  get: (fileId) => getDraft(fileId),
  clear: async (fileId) => { await clearDraft(fileId); },
};
