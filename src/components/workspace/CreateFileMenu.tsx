import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { QUICK_FILE_TYPES, isValidExtension, lastFileType } from '../../lib/workspace/file-types';
import { useT } from '../../i18n';

// The type menu for a new file: the listed types with the one picked last
// time first, and a box for any other extension. It only says which type
// was picked; where the file goes is the caller's business.

interface Props {
  title: string;
  onPick: (extension: string) => void;
  onClose: () => void;
  style?: CSSProperties;
}

export default function CreateFileMenu({ title, onPick, onClose, style }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [typing, setTyping] = useState(false);
  const [extension, setExtension] = useState('');
  const last = lastFileType();
  const listed = [...QUICK_FILE_TYPES].sort((a, b) => Number(b.extension === last) - Number(a.extension === last));
  const lastIsListed = listed.some((type) => type.extension === last);
  const valid = isValidExtension(extension);

  useEffect(() => {
    const outside = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose(); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', outside);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', outside); window.removeEventListener('keydown', escape); };
  }, [onClose]);

  const row = 'w-full px-3 py-1.5 flex items-center justify-between gap-3 text-xs text-ink hover:bg-wash transition-colors text-left';

  return (
    <div ref={rootRef} style={style} data-create-file-menu
      className="fixed z-50 w-[220px] max-h-[70vh] overflow-y-auto bg-card border border-line rounded-xl shadow-lg py-1">
      <div className="px-3 py-1.5 text-2xs text-ink-faint truncate" title={title}>{title}</div>
      {!lastIsListed && (
        <button className={row} data-file-type={last} onClick={() => onPick(last)}>
          <span className="font-mono">.{last}</span>
        </button>
      )}
      {listed.map((type) => (
        <button key={type.extension} className={row} data-file-type={type.extension} onClick={() => onPick(type.extension)}>
          <span className={type.extension === last ? 'font-medium' : ''}>{t(type.labelKey)}</span>
          <span className="font-mono text-2xs text-ink-faint">.{type.extension}</span>
        </button>
      ))}
      <div className="border-t border-line/70 mt-1 pt-1">
        {typing ? (
          <form className="px-3 py-1.5" onSubmit={(e) => { e.preventDefault(); if (valid) onPick(extension); }}>
            <input
              autoFocus
              value={extension}
              onChange={(e) => setExtension(e.target.value.trim())}
              placeholder={t('workspace.otherTypePlaceholder')}
              data-file-type-input
              className="w-full bg-wash border border-line rounded-md px-2 py-1 text-xs font-mono text-ink outline-none focus:border-accent/60"
            />
            {extension !== '' && !valid && <p className="text-2xs text-red-500 mt-1">{t('workspace.invalidExtension')}</p>}
          </form>
        ) : (
          <button className={`${row} text-ink-muted`} data-file-type-other onClick={() => setTyping(true)}>{t('workspace.otherType')}</button>
        )}
      </div>
    </div>
  );
}
