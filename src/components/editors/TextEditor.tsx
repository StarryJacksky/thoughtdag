import { useEffect, useRef } from 'react';
import { bindEditor } from './codemirror-document';

// The text of a document, to read and type into: a CodeMirror view bound to
// the shared document (see codemirror-document.ts). It holds no text of its
// own beyond what it shows.

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
}

export default function TextEditor({ documentId, surfaceId, onSave }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const save = useRef(onSave);
  useEffect(() => { save.current = onSave; }, [onSave]);

  useEffect(() => {
    if (!holder.current) return;
    const bound = bindEditor(holder.current, documentId, surfaceId, () => save.current());
    return () => bound?.destroy();
  }, [documentId, surfaceId]);

  return <div ref={holder} className="flex-1 min-h-0 min-w-0 overflow-hidden" data-surface-editor />;
}
