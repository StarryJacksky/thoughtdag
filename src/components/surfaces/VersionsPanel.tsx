import { useCallback, useEffect, useState } from 'react';
import { Eye, RotateCcw } from 'lucide-react';
import { documents } from '../../lib/documents/document-service';
import { compareLines } from '../../lib/documents/line-diff';
import { listVersions, readVersion } from '../../lib/workspace/client';
import type { ContentHash, FileVersion } from '../../lib/workspace/contracts';
import { toast } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';
import { useDocument } from './use-document';

// What a file held before each save, in the surface of its document: the
// versions the workspace kept, newest first. One of them can be looked at,
// which changes nothing, or put back, which is a save like any other: it
// happens only over the content the person is looking at, and what it
// replaces is kept as a version in turn.

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sizeOf = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export default function VersionsPanel({ documentId }: { documentId: string }) {
  const t = useT();
  const { model } = useDocument(documentId);
  const fileId = model?.fileId ?? '';
  const [versions, setVersions] = useState<FileVersion[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState<{ revision: ContentHash; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!fileId) return;
    try { setVersions(await listVersions(fileId)); setFailed(null); } catch (e) { setFailed(why(e)); setVersions([]); }
  }, [fileId]);
  // read when the panel opens, and again whenever the file's content is another: a save has kept a new version
  const revision = model?.sourceContentHash;
  useEffect(() => { void load(); }, [load, revision]);

  if (!model) return null;
  const canPutBack = model.state !== 'readonly';
  // putting a version back replaces the file: typing that is not saved yet would be lost to it
  const unsaved = model.state !== 'clean';

  const look = async (version: FileVersion) => {
    if (shown?.revision === version.revision) { setShown(null); return; }
    try { setShown({ revision: version.revision, text: (await readVersion(fileId, version.revision)).text }); } catch (e) { toast('error', fmt(t('workspace.failed'), { why: why(e) })); }
  };
  const putBack = async (version: FileVersion) => {
    setBusy(true);
    try {
      const result = await documents.restoreVersion(documentId, version.revision);
      if (result.status === 'conflict') toast('error', t('versions.changedElsewhere'));
      else if (result.status !== 'saved') toast('error', fmt(t('workspace.failed'), { why: result.reason }));
      else setShown(null);
    } finally {
      setBusy(false);
      void load();
    }
  };

  return (
    <div className="shrink-0 max-h-[45%] overflow-y-auto border-t border-line/70 bg-wash/50 px-3 py-2" data-versions>
      <p className="text-2xs text-ink-muted leading-snug mb-1.5">{t(canPutBack ? 'versions.hint' : 'versions.hintReadOnly')}</p>
      {versions === null ? <p className="text-2xs text-ink-faint" data-versions-loading>{t('workspace.loading')}</p>
        : failed ? <p className="text-2xs text-red-600">{fmt(t('workspace.failed'), { why: failed })}</p>
          : versions.length === 0 ? <p className="text-2xs text-ink-faint" data-versions-empty>{t('versions.none')}</p>
            : versions.map((version) => (
              <div key={version.revision} data-version={version.revision} className="py-1 border-b border-line/40 last:border-b-0">
                <div className="flex items-center gap-2 text-2xs">
                  <span className="flex-1 min-w-0 truncate text-ink">{new Date(version.keptAt).toLocaleString()}</span>
                  <span className="shrink-0 text-ink-faint font-mono">{sizeOf(version.size)}</span>
                  <button onClick={() => void look(version)} data-version-preview title={t('versions.look')}
                    className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-ink-muted hover:text-ink hover:bg-line/40 transition-colors">
                    <Eye size={11} strokeWidth={1.75} /> {t('versions.look')}
                  </button>
                  {canPutBack && (
                    <button onClick={() => void putBack(version)} disabled={busy || unsaved} data-version-restore title={unsaved ? t('versions.saveFirst') : t('versions.putBackTitle')}
                      className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-accent hover:bg-accent/10 disabled:opacity-40 disabled:hover:bg-transparent transition-colors">
                      <RotateCcw size={11} strokeWidth={1.75} /> {t('versions.putBack')}
                    </button>
                  )}
                </div>
                {shown?.revision === version.revision && (
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-card border border-line/60 px-2 py-1.5 text-2xs font-mono text-ink-muted whitespace-pre-wrap break-words" data-version-text>{shown.text}</pre>
                )}
              </div>
            ))}
    </div>
  );
}

/**
 * The two sides of a conflict beside each other, line by line: what is in
 * the buffer on the left, what the file holds on the right, the lines
 * that differ marked. It shows; choosing between the two is done with the
 * buttons under it, as before.
 */
export function ConflictCompare({ mine, theirs }: { mine: string; theirs: string }) {
  const t = useT();
  const rows = compareLines(mine, theirs);
  const cell = 'px-2 py-0.5 font-mono text-2xs whitespace-pre-wrap break-words align-top w-1/2';
  return (
    <div className="max-h-48 overflow-auto rounded border border-amber-200 bg-card mt-1.5" data-compare>
      <table className="w-full border-collapse table-fixed">
        <thead>
          <tr className="text-2xs text-ink-muted bg-wash">
            <th className="px-2 py-1 text-left font-normal">{t('resource.mine')}</th>
            <th className="px-2 py-1 text-left font-normal border-l border-line/60">{t('resource.theirs')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} data-compare-row={row.changed ? 'changed' : 'same'} className={row.changed ? 'bg-amber-50' : ''}>
              <td className={`${cell} ${row.changed ? 'text-ink' : 'text-ink-faint'}`} data-compare-mine>{row.mine ?? ''}</td>
              <td className={`${cell} border-l border-line/60 ${row.changed ? 'text-ink' : 'text-ink-faint'}`} data-compare-theirs>{row.theirs ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
