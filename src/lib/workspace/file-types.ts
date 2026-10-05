// The file types offered when creating a file: one entry per extension,
// with the label shown and the kind of editor it opens in. The list is what
// the quick menu shows; any other text extension can be typed in.

import type { MessageKey } from '../../i18n';

export type EditorKind = 'text' | 'markdown' | 'mindmap';

export interface FileType {
  extension: string;
  labelKey: MessageKey;
  editorKind: EditorKind;
}

export const QUICK_FILE_TYPES: readonly FileType[] = [
  { extension: 'md', labelKey: 'fileType.md', editorKind: 'markdown' },
  { extension: 'txt', labelKey: 'fileType.txt', editorKind: 'text' },
  { extension: 'tex', labelKey: 'fileType.tex', editorKind: 'text' },
  { extension: 'py', labelKey: 'fileType.py', editorKind: 'text' },
  { extension: 'json', labelKey: 'fileType.json', editorKind: 'text' },
  { extension: 'yaml', labelKey: 'fileType.yaml', editorKind: 'text' },
  { extension: 'csv', labelKey: 'fileType.csv', editorKind: 'text' },
  { extension: 'html', labelKey: 'fileType.html', editorKind: 'text' },
  { extension: 'js', labelKey: 'fileType.js', editorKind: 'text' },
  { extension: 'ts', labelKey: 'fileType.ts', editorKind: 'text' },
  { extension: 'bib', labelKey: 'fileType.bib', editorKind: 'text' },
  { extension: 'tdmap', labelKey: 'fileType.tdmap', editorKind: 'mindmap' },
];

/** The listed type for an extension, or null for one that is typed in by hand. */
export function fileTypeOf(extension: string): FileType | null {
  const wanted = extension.toLowerCase();
  return QUICK_FILE_TYPES.find((t) => t.extension === wanted) ?? null;
}

/** An extension the shell will accept: letters and digits, no dot, no path. */
export function isValidExtension(extension: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(extension);
}

const LAST_TYPE_KEY = 'thoughtdag.lastFileType';

/** The extension picked last time; Markdown the first time. */
export function lastFileType(): string {
  try {
    const saved = localStorage.getItem(LAST_TYPE_KEY);
    if (saved && isValidExtension(saved)) return saved;
  } catch { /* private mode */ }
  return 'md';
}

export function rememberFileType(extension: string): void {
  if (!isValidExtension(extension)) return;
  try { localStorage.setItem(LAST_TYPE_KEY, extension); } catch { /* private mode */ }
}

// Kinds whose bytes are not text: a node can hold a readable copy of them,
// but they are never opened for typing.
const NOT_TEXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'zip', 'gz', 'tar']);

/** Whether a file of this name is one whose text can be typed into. */
export function isEditableText(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return !NOT_TEXT.has(dot > 0 ? name.slice(dot + 1).toLowerCase() : '');
}
