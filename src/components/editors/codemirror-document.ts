// A CodeMirror view as one view of a shared document. The document service
// holds the text; the editor shows it and types into it. What is typed here
// becomes an edit of the document, on the buffer revision this view last
// saw; what happens to the document elsewhere (another view typing, an
// undo, the file reloaded) is applied to what the editor shows.
//
// Undo is the document's, not the editor's: the editor keeps no history of
// its own, and its undo keys ask the document.
//
// While a word is being composed (an input method putting together a
// Chinese word, say) nothing is sent: the half-made word is not an edit.
// When the composition ends, what it left is one edit.

import { Annotation, ChangeSet, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { documents } from '../../lib/documents/document-service';
import { changeBetween, type Change } from '../../lib/documents/history';

/** Marks a transaction that brings the document's state into the editor: it is not typing, and is not sent back. */
const fromDocument = Annotation.define<boolean>();

/** The language of a file by its name; plain text for the ones not known here. */
async function languageOf(name: string): Promise<Extension> {
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  switch (extension) {
    case 'md': case 'markdown': return markdown();
    case 'tex': case 'bib': case 'sty': case 'cls': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/stex')).stex);
    // Python is indented by four spaces: the step a new block is given
    case 'py': return [StreamLanguage.define((await import('@codemirror/legacy-modes/mode/python')).python), indentUnit.of('    ')];
    case 'js': case 'jsx': case 'mjs': case 'cjs': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/javascript')).javascript);
    case 'ts': case 'tsx': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/javascript')).typescript);
    case 'json': case 'tdmap': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/javascript')).json);
    case 'yaml': case 'yml': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/yaml')).yaml);
    case 'css': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/css')).css);
    case 'sh': case 'bash': case 'zsh': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'r': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/r')).r);
    default: return [];
  }
}

export interface BoundEditor {
  view: EditorView;
  /** Let go: the editor is destroyed. The document is not touched; closing its view is the surface's to do. */
  destroy(): void;
}

/**
 * Put an editor for a document into `parent`. `onSave` is called for the
 * save key. Returns null when the document is not open.
 */
export function bindEditor(parent: HTMLElement, documentId: string, surfaceId: string, onSave: () => void): BoundEditor | null {
  const model = documents.get(documentId);
  if (!model) return null;
  // the buffer revision the editor's content corresponds to
  let seen = model.bufferRevision;
  // set while this editor's own typing is being handed to the document: the document's news of it is not applied again
  let sending = false;
  // Typing held back because a word was being composed: what the editor showed when the holding
  // began, and what happened to the document in the meantime (so the word lands in the right place).
  let heldFrom: string | null = null;
  let missed: ChangeSet | null = null;
  let isReadOnly = model.state === 'readonly';
  const readOnly = new Compartment();
  const language = new Compartment();

  /** Make the editor show what the document holds, by the one change that differs. */
  const catchUp = () => {
    const now = documents.get(documentId);
    if (!now) return;
    const changes = changeBetween(view.state.doc.toString(), now.text);
    if (changes.length > 0) view.dispatch({ changes, annotations: fromDocument.of(true) });
    seen = now.bufferRevision;
  };

  /** Hand what was typed here to the document as one edit. */
  const send = () => {
    const from = heldFrom;
    const meanwhile = missed;
    heldFrom = null;
    missed = null;
    sending = true;
    let taken = true;
    try {
      const shown = view.state.doc.toString();
      if (from !== null && meanwhile) {
        // the document moved on while the word was being composed: the word is placed where its place is now
        const typed = ChangeSet.of(changeBetween(from, shown), from.length).map(meanwhile);
        const changes: Change[] = [];
        typed.iterChanges((fromA, toA, _fromB, _toB, inserted) => { changes.push({ from: fromA, to: toA, insert: inserted.toString() }); });
        const now = documents.get(documentId);
        if (changes.length > 0 && now) taken = documents.applyEdit(documentId, { baseBufferRevision: now.bufferRevision, changes, originSurfaceId: surfaceId }).ok;
      } else {
        const result = documents.setText(documentId, shown, surfaceId);
        taken = result.ok;
        seen = result.bufferRevision;
      }
    } finally { sending = false; }
    // the document may not have taken it (it is read-only, say), or holds more than was typed here: the editor shows what the document holds
    if (!taken || meanwhile) catchUp();
  };

  const undo = (direction: 'undo' | 'redo') => () => { if (direction === 'undo') documents.undo(documentId, surfaceId); else documents.redo(documentId, surfaceId); return true; };

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: model.text,
      extensions: [
        lineNumbers(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        readOnly.of(EditorState.readOnly.of(model.state === 'readonly')),
        language.of([]),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } },
          // undo and redo are the document's, shared by every view of the file
          { key: 'Mod-z', preventDefault: true, run: undo('undo') },
          { key: 'Mod-Shift-z', preventDefault: true, run: undo('redo') },
          { key: 'Mod-y', preventDefault: true, run: undo('redo') },
          indentWithTab,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.every((tr) => tr.annotation(fromDocument))) return;
          // a word still being put together is not an edit yet
          if (view.compositionStarted) { heldFrom ??= update.startState.doc.toString(); return; }
          send();
        }),
        EditorView.domEventHandlers({
          // the composition is over once the editor has taken its last change in: then what it left is sent
          compositionend: () => { setTimeout(() => { if (heldFrom !== null && !view.compositionStarted) send(); }, 0); return false; },
          blur: () => { if (heldFrom !== null && !view.compositionStarted) send(); return false; },
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.6' },
          '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--color-ink-faint)' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    }),
  });

  const stop = documents.subscribe(documentId, (now, change) => {
    if (isReadOnly !== (now.state === 'readonly')) {
      isReadOnly = now.state === 'readonly';
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(isReadOnly)) });
    }
    // only the state changed, or it is this editor's own typing coming back
    if (!change.changes || sending) return;
    if (heldFrom !== null) {
      // a word is being composed here: the editor is not disturbed, and what happened is kept to place the word by
      const before = now.text.length - change.changes.reduce((n, c) => n + c.insert.length - (c.to - c.from), 0);
      const set = ChangeSet.of(change.changes, before);
      missed = missed ? missed.compose(set) : set;
      return;
    }
    if (seen + 1 === now.bufferRevision) {
      // the editor was one step behind: the same change is applied to it, so the cursor moves with the text
      try { view.dispatch({ changes: change.changes, annotations: fromDocument.of(true) }); } catch { /* it did not fit what the editor shows */ }
    }
    if (view.state.doc.toString() !== now.text) catchUp();
    seen = now.bufferRevision;
  });

  void languageOf(documents.status(documentId)?.name ?? '').then((extension) => view.dispatch({ effects: language.reconfigure(extension) })).catch(() => {});

  return { view, destroy() { stop(); view.destroy(); } };
}
