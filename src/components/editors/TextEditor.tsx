import { useEffect, useRef } from 'react';
import { bindEditor, type BoundEditor } from './codemirror-document';

// The text of a document, to read and type into: a CodeMirror view bound to
// the shared document (see codemirror-document.ts). It holds no text of its
// own beyond what it shows. `preview` shows a Markdown source laid out as
// it reads, or a LaTeX source with its formulas drawn.

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
  preview?: boolean;
  /** the editor's own key for turning the preview on and off was pressed */
  onTogglePreview?: () => void;
}

export default function TextEditor({ documentId, surfaceId, onSave, preview = false, onTogglePreview }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const bound = useRef<BoundEditor | null>(null);
  const save = useRef(onSave);
  const toggle = useRef(onTogglePreview);
  const shown = useRef(preview);
  useEffect(() => { save.current = onSave; toggle.current = onTogglePreview; }, [onSave, onTogglePreview]);

  useEffect(() => {
    if (!holder.current) return;
    bound.current = bindEditor(holder.current, documentId, surfaceId, () => save.current(), { preview: shown.current, onTogglePreview: () => toggle.current?.() });
    return () => { bound.current?.destroy(); bound.current = null; };
  }, [documentId, surfaceId]);

  useEffect(() => {
    if (shown.current === preview) return;
    shown.current = preview;
    bound.current?.setPreview(preview);
  }, [preview]);

  return <div ref={holder} className="flex-1 min-h-0 min-w-0 overflow-hidden" data-surface-editor />;
}
