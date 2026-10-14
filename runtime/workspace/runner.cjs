// Running a file of a workspace with the tools installed on this machine:
// a script by its interpreter, a program compiled and then run, a LaTeX
// source compiled to a PDF that is put beside it. It is what the editor's
// run button asks for, and nothing else asks for it.
//
// What it promises:
//   - A file is run only when a page asks, and only the file named by its
//     identity in an open workspace. What runs it is fixed by the file's
//     kind (the table below); the file is handed over as one argument,
//     never through a shell, whatever its name holds.
//   - It runs in the file's own folder, as the person's tool would.
//   - A compiled program, and everything a compiler writes, is built in a
//     folder of its own outside the workspace and removed afterwards; only
//     a LaTeX source's PDF is put in the workspace, beside the source.
//   - A run can be stopped: its whole process group is ended. The runs of
//     a page that goes away are stopped with it.
//   - A LaTeX source compiles without the person installing anything: the
//     TeX on this machine when there is one (it is the most complete),
//     else the engine the app brings (Tectonic), which fetches a package
//     the first time a source needs it and keeps it.
//
// What it does not promise: a script is the person's own program and can
// do whatever their account can. Running it is their choice, each time.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { WorkspaceAccessError } = require('./path-policy.cjs');

/** Where tools are installed on this kind of machine, looked in as well as the PATH: a window opened from the Dock is not given the shell's PATH. */
const SEARCH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin', path.join(os.homedir(), '.cargo', 'bin'), '/usr/local/go/bin', '/opt/homebrew/opt/openjdk/bin'];
/** More output than this from one run is not passed on: the rest is said to be cut. */
const MAX_OUTPUT = 2 * 1024 * 1024;

/** The tool of this name, as an absolute path, from the PATH or the folders tools are installed in; null when there is none. */
function findTool(name, pathList = process.env.PATH ?? '', searchDirs = SEARCH_DIRS) {
  const dirs = [...String(pathList).split(path.delimiter), ...searchDirs].filter(Boolean);
  for (const dir of new Set(dirs)) {
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }
  return null;
}

const script = (label, tool, ...flags) => ({ kind: 'script', label, needs: [tool], steps: [[tool, ...flags, '{file}']] });
const compiled = (label, compiler, ...flags) => ({ kind: 'compiled', label, needs: [compiler], steps: [[compiler, ...flags, '{file}', '-o', '{program}'], ['{program}']] });

/** What runs each kind of file. Nothing else is ever run. */
const KINDS = {
  py: script('Python', 'python3', '-u'),
  js: script('JavaScript', 'node'), mjs: script('JavaScript', 'node'), cjs: script('JavaScript', 'node'),
  ts: script('TypeScript', 'node', '--experimental-strip-types', '--no-warnings'), mts: script('TypeScript', 'node', '--experimental-strip-types', '--no-warnings'),
  sh: script('Shell', 'bash'), bash: script('Shell', 'bash'), zsh: script('Shell', 'zsh'),
  rb: script('Ruby', 'ruby'), pl: script('Perl', 'perl'), r: script('R', 'Rscript'), jl: script('Julia', 'julia'), lua: script('Lua', 'lua'), swift: script('Swift', 'swift'),
  java: script('Java', 'java'),
  go: { kind: 'compiled', label: 'Go', needs: ['go'], steps: [['go', 'run', '{file}']] },
  c: compiled('C', 'cc', '-std=c11', '-O1'),
  cpp: compiled('C++', 'c++', '-std=c++17', '-O1'), cc: compiled('C++', 'c++', '-std=c++17', '-O1'), cxx: compiled('C++', 'c++', '-std=c++17', '-O1'),
  rs: compiled('Rust', 'rustc', '-O'),
  tex: { kind: 'latex', label: 'LaTeX' }, ltx: { kind: 'latex', label: 'LaTeX' },
};

const extensionOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');
/** A source that needs XeLaTeX: Chinese in it, or the packages that set it. */
const needsXeTeX = (text) => /\\documentclass(\[[^\]]*\])?\{ctex|\\usepackage(\[[^\]]*\])?\{(ctex|xeCJK|fontspec)\}|[㐀-鿿]/.test(text);

/**
 * The runner.
 *   service     the workspace service: where a file is, and putting a PDF beside its source
 *   send        `(owner, event)`: an event of a run, to the page (owner) that started it
 *   path        the PATH to look in (the process's by default); searchDirs: the folders looked in as well
 */
function createRunner({ service, send, spawn = spawnProcess, path: pathList = process.env.PATH ?? '', searchDirs = SEARCH_DIRS, env = process.env, tmpdir = os.tmpdir(), tectonic = null }) {
  const runs = new Map(); // runId → { owner, fileId, child, stopped }
  const searchPath = [...String(pathList).split(path.delimiter), ...searchDirs].filter(Boolean).join(path.delimiter);
  const tool = (name) => findTool(name, pathList, searchDirs);

  /** The engine the app brings, when it is there: the one shipped with the app, else one on this machine. */
  const builtIn = () => {
    if (tectonic) { try { fs.accessSync(tectonic, fs.constants.X_OK); return tectonic; } catch { /* not shipped in this build */ } }
    return tool('tectonic');
  };

  /**
   * The plan for a LaTeX source, with the engine the source needs: the
   * TeX on this machine (latexmk when there is one, else the engine twice,
   * for references), else the built-in engine. None of them is let run
   * the shell commands a source may ask for.
   */
  function latexPlan(text) {
    const engine = needsXeTeX(text) ? 'xelatex' : 'pdflatex';
    const flags = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-no-shell-escape'];
    if (tool('latexmk') && tool(engine)) return { needs: ['latexmk', engine], engine, steps: [['latexmk', engine === 'xelatex' ? '-xelatex' : '-pdf', ...flags, '-outdir={build}', '{file}']] };
    if (tool(engine)) {
      const once = [engine, ...flags, '-output-directory={build}', '{file}'];
      return { needs: [engine], engine, steps: [once, once] };
    }
    const own = builtIn();
    if (own) return { needs: [], engine: 'tectonic', steps: [[own, '-X', 'compile', '--untrusted', '--outdir', '{build}', '{file}']] };
    return { needs: [engine], engine, steps: [] };
  }

  async function planFor(fileId) {
    const record = await service.resourceRecord(fileId);
    if (!record) throw new WorkspaceAccessError('unknown-file', 'that file is not known to an open workspace');
    const kind = KINDS[extensionOf(record.relativePath ?? '')];
    if (!kind) return { record, kind: null };
    if (kind.kind !== 'latex') return { record, kind, needs: kind.needs, steps: kind.steps };
    let text = '';
    try { text = (await service.readText(fileId)).text; } catch { /* the plan does not depend on reading it */ }
    return { record, kind, ...latexPlan(text) };
  }

  const emit = (owner, event) => { try { send(owner, event); } catch { /* the page is gone */ } };

  /** Run one step; resolves with how it ended. */
  function step(run, argv, cwd) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, PATH: searchPath }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false });
      } catch (e) { resolve({ code: null, error: e.message }); return; }
      run.child = child;
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (bytes) => {
          if (run.sent > MAX_OUTPUT) return;
          run.sent += bytes.length;
          const text = decoders[stream].decode(bytes, { stream: true });
          if (text) emit(run.owner, { runId: run.runId, type: 'output', stream, text });
          if (run.sent > MAX_OUTPUT) emit(run.owner, { runId: run.runId, type: 'output', stream: 'stderr', text: '\n[output cut: more than 2 MB]\n' });
        });
      }
      child.on('error', (e) => resolve({ code: null, error: e.message }));
      child.on('close', (code, signal) => { run.child = null; resolve({ code, signal }); });
    });
  }

  async function execute(run, plan, file) {
    const started = Date.now();
    const build = fs.mkdtempSync(path.join(tmpdir, 'tdag-run-'));
    const fill = (arg) => arg.replace('{file}', file).replace('{program}', path.join(build, 'program')).replace('{build}', build);
    const finish = (event) => {
      runs.delete(run.runId);
      fs.rmSync(build, { recursive: true, force: true });
      emit(run.owner, { runId: run.runId, type: 'end', ms: Date.now() - started, ...event });
    };
    try {
      for (const [index, template] of plan.steps.entries()) {
        if (run.stopped) return finish({ status: 'stopped', code: null });
        const argv = template.map(fill);
        argv[0] = argv[0] === path.join(build, 'program') ? argv[0] : (tool(argv[0]) ?? argv[0]);
        emit(run.owner, { runId: run.runId, type: 'step', index, command: argv.map((a) => (a === file ? path.basename(file) : a.startsWith(build) ? a.replace(build, '…') : a)).join(' ') });
        const ended = await step(run, argv, path.dirname(file));
        if (run.stopped) return finish({ status: 'stopped', code: null });
        if (ended.error) return finish({ status: 'failed', code: null, reason: ended.error });
        if (ended.code !== 0) return finish({ status: 'failed', code: ended.code });
      }
      if (plan.kind.kind === 'latex') {
        const name = `${path.basename(file).replace(/\.[^.]+$/, '')}.pdf`;
        const made = path.join(build, name);
        if (!fs.existsSync(made)) return finish({ status: 'failed', code: 0, reason: 'the compiler made no PDF' });
        const record = await service.putBeside(run.fileId, name, fs.readFileSync(made));
        return finish({ status: 'ok', code: 0, output: record.fileId });
      }
      return finish({ status: 'ok', code: 0 });
    } catch (e) {
      return finish({ status: 'failed', code: null, reason: e && e.message ? e.message : String(e) });
    }
  }

  function kill(run) {
    run.stopped = true;
    const child = run.child;
    if (!child || child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { if (run.child === child) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } }, 2000).unref?.();
  }

  return {
    /** What would run a file, and which of those tools this machine lacks. Runs nothing. */
    async tools(fileId) {
      const plan = await planFor(fileId);
      if (!plan.kind) return { kind: null, label: null, needs: [], missing: [] };
      return { kind: plan.kind.kind, label: plan.kind.label, needs: plan.needs, missing: plan.needs.filter((name) => !tool(name)), ...(plan.engine ? { engine: plan.engine } : {}) };
    },

    /** Run a file for a page. Resolves with the run's id at once; what happens is sent as events, ending with one `end`. */
    async start(owner, fileId) {
      const plan = await planFor(fileId);
      if (!plan.kind) throw new WorkspaceAccessError('unsupported', 'nothing here runs a file of this kind');
      const file = await service.locate(fileId);
      // one run of a file at a time: running it again stops the one before
      for (const other of runs.values()) if (other.fileId === fileId) kill(other);
      const run = { runId: `run_${randomUUID()}`, owner, fileId, child: null, stopped: false, sent: 0 };
      runs.set(run.runId, run);
      emit(owner, { runId: run.runId, type: 'start', fileId, command: plan.steps.map((s) => s.map((a) => (a === '{file}' ? path.basename(file) : a)).join(' ')).join(' && ') });
      const missing = plan.needs.filter((name) => !tool(name));
      if (missing.length > 0) {
        runs.delete(run.runId);
        emit(owner, { runId: run.runId, type: 'end', status: 'unavailable', code: null, missing, ms: 0 });
      } else void execute(run, plan, file);
      return run.runId;
    },

    /** Stop a run. Only the page that started it may. */
    async stop(owner, runId) {
      const run = runs.get(String(runId));
      if (!run) return false;
      if (run.owner !== owner) throw new WorkspaceAccessError('not-yours', 'that run was started by another page');
      kill(run);
      return true;
    },

    /** Stop every run a page started: the page went away. */
    releaseOwner(owner) {
      for (const run of [...runs.values()]) if (run.owner === owner) kill(run);
    },
  };
}

module.exports = { createRunner, findTool, SEARCH_DIRS, KINDS };
