import { useState } from 'react';
import { Play, Square, TerminalSquare } from 'lucide-react';
import { useT, fmt } from '../../i18n';
import { documents } from '../../lib/documents/document-service';
import TextEditor from './TextEditor';
import RunPanel from './RunPanel';
import { useRun } from './use-run';

// A file of code, in a light editor of the kind programmers use: a bar
// with the language and the run button, the code with its line numbers,
// folding, find and replace (Mod-F) and brackets that close themselves,
// the output of a run under it, and where the cursor is. A run happens
// only when the button is pressed, with the tools installed on this
// machine (see runtime/workspace/runner.cjs).

interface Props {
  documentId: string;
  surfaceId: string;
  onSave: () => void;
}

const LANGUAGES: Record<string, string> = {
  py: 'Python', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', css: 'CSS', sh: 'Shell', bash: 'Shell', zsh: 'Shell', r: 'R', jl: 'Julia', rb: 'Ruby', pl: 'Perl', lua: 'Lua',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++', rs: 'Rust', go: 'Go', java: 'Java', swift: 'Swift', sql: 'SQL', bib: 'BibTeX', csv: 'CSV', tdmap: 'JSON',
};
const languageOfName =(name: string): string => LANGUAGES[name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''] ?? 'Text';

export default function CodeEditor({ documentId, surfaceId, onSave }: Props) {
  const t = useT();
  const name = documents.status(documentId)?.name ?? '';
  const { state, run, halt, clear, runnable } = useRun(documentId);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [panel, setPanel] = useState(false);
  const missing = state.tools?.missing ?? [];
  const running = state.status === 'running';
  const start = () => { setPanel(true); void run(); };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-line/60 bg-wash/40 text-2xs">
        <span className="px-1.5 py-0.5 rounded bg-card border border-line/60 text-ink-muted font-mono" data-code-language>{languageOfName(name)}</span>
        <span className="flex-1" />
        {missing.length > 0 && <span className="text-amber-700 truncate" data-code-missing title={t('run.installHint')}>{fmt(t('run.missing'), { tools: missing.join(', ') })}</span>}
        {runnable && (running
          ? <button onClick={halt} data-code-stop className="h-6 px-2 rounded flex items-center gap-1 text-red-600 hover:bg-red-50 transition-colors"><Square size={11} strokeWidth={2} /> {t('run.stop')}</button>
          : <button onClick={start} disabled={missing.length > 0} data-code-run title={t(state.tools?.kind === 'compiled' ? 'run.compileTitle' : 'run.runTitle')}
            className="h-6 px-2 rounded flex items-center gap-1 text-green-700 hover:bg-green-50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors">
            <Play size={11} strokeWidth={2} /> {t(state.tools?.kind === 'compiled' ? 'run.compileRun' : 'run.run')}
          </button>)}
        {runnable && (
          <button onClick={() => setPanel((on) => !on)} title={t('run.output')} data-code-output-toggle aria-pressed={panel}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${panel ? 'text-accent bg-accent/10' : 'text-ink-faint hover:text-ink hover:bg-wash'}`}>
            <TerminalSquare size={12} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <TextEditor documentId={documentId} surfaceId={surfaceId} onSave={onSave} onCursor={(line, column) => setCursor({ line, column })} />
      {panel && state.status !== 'idle' && <RunPanel state={state} onClear={clear} onClose={() => setPanel(false)} />}
      <div className="shrink-0 flex items-center gap-3 px-3 py-0.5 border-t border-line/50 text-[11px] text-ink-faint font-mono">
        <span data-code-cursor>{fmt(t('run.cursor'), { line: cursor.line, column: cursor.column })}</span>
        <span>{languageOfName(name)}</span>
        <span>UTF-8</span>
      </div>
    </div>
  );
}
