import { useEffect, useState } from 'react';
import { documents, type DocumentStatus } from '../../lib/documents/document-service';
import type { DocumentModel } from '../../lib/workspace/contracts';

/** The document as it is now, kept up to date for as long as the view is mounted. */
export function useDocument(documentId: string): { model: DocumentModel | null; status: DocumentStatus | null } {
  const [, setTick] = useState(0);
  useEffect(() => documents.subscribe(documentId, () => setTick((n) => n + 1)), [documentId]);
  return { model: documents.get(documentId) ?? null, status: documents.status(documentId) ?? null };
}
