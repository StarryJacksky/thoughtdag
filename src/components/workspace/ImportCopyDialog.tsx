import { useState } from 'react';
import { importText, newOperationId } from '../../lib/workspace/client';
import type { ResourceRecord } from '../../lib/workspace/contracts';
import { isValidExtension } from '../../lib/workspace/file-types';
import { useT } from '../../i18n';

// Text from somewhere this app cannot open directly, pasted in as a local
// file. The file is an ordinary one, marked as a copy with where it was
// copied from; nothing keeps it in step with the original.

interface Props {
  workspaceId: string;
  parentId?: string;
  /** which source the box starts on: a space when the person came here from that entry */
  source?: 'chatgpt-space' | 'other';
  onDone: (record: ResourceRecord) => void;
  onFailed: (why: string) => void;
  onClose: () => void;
}

export default function ImportCopyDialog({ workspaceId, parentId, source: initialSource = 'other', onDone, onFailed, onClose }: Props) {
  const t = useT();
  const [name, setName] = useState('');
  const [extension, setExtension] = useState('md');
  const [source, setSource] = useState<'chatgpt-space' | 'other'>(initialSource);
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = text !== '' && isValidExtension(extension) && !busy;

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      onDone(await importText(
        { workspaceId, ...(parentId ? { parentId } : {}), extension, origin: 'workspace', idempotencyKey: newOperationId() },
        { text, name: name.trim() || null, provenance: { source, ...(note.trim() ? { note: note.trim() } : {}) } },
      ));
    } catch (e) {
      onFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full bg-wash border border-line rounded-md px-2 py-1.5 text-xs text-ink outline-none focus:border-accent/60';
  const label = 'block text-2xs text-ink-muted mb-1';

  return (
    <div className="fixed inset-0 z-[120] bg-black/30 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }} data-import-copy>
      <div className="w-[520px] max-w-[92vw] bg-card border border-line rounded-2xl shadow-xl p-5 flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium text-ink">{t('workspace.importTitle')}</h2>
          <p className="text-2xs text-ink-muted mt-1 leading-snug">{t('workspace.importHint')}</p>
        </div>
        <div className="flex gap-3">
          <label className="flex-1 min-w-0">
            <span className={label}>{t('workspace.importName')}</span>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} data-import-name />
          </label>
          <label className="w-[84px] shrink-0">
            <span className={label}>{t('workspace.importExtension')}</span>
            <input className={`${field} font-mono`} value={extension} onChange={(e) => setExtension(e.target.value.trim())} data-import-extension />
          </label>
        </div>
        <div className="flex gap-3">
          <label className="w-[150px] shrink-0">
            <span className={label}>{t('workspace.importSource')}</span>
            <select className={field} value={source} onChange={(e) => setSource(e.target.value === 'chatgpt-space' ? 'chatgpt-space' : 'other')} data-import-source>
              <option value="chatgpt-space">{t('workspace.importSourceSpace')}</option>
              <option value="other">{t('workspace.importSourceOther')}</option>
            </select>
          </label>
          <label className="flex-1 min-w-0">
            <span className={label}>{t('workspace.importNote')}</span>
            <input className={field} value={note} onChange={(e) => setNote(e.target.value)} data-import-note />
          </label>
        </div>
        <textarea
          className={`${field} font-mono h-[220px] resize-none`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('workspace.importText')}
          data-import-text
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-ink-muted hover:bg-wash transition-colors">{t('workspace.cancel')}</button>
          <button onClick={() => void save()} disabled={!ready} data-import-save
            className="px-3 py-1.5 rounded-lg text-xs text-white bg-accent hover:opacity-90 disabled:opacity-40 transition-opacity">
            {t('workspace.importDo')}
          </button>
        </div>
      </div>
    </div>
  );
}
