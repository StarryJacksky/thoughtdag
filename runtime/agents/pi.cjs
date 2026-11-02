// Pi as an agent runtime for the desktop shell. One `pi --mode rpc` child
// per working directory, spoken to in JSONL: commands go down stdin with an
// id and come back as `response` lines; everything else on stdout is a
// session event (agent_start, message_update, tool_execution_*, agent_end…)
// which the shell forwards to the renderer untouched, tagged with the run
// it belongs to. Pi keeps its own session files (~/.pi/agent/sessions), its
// own keys and model catalog: the shell only asks, never copies.
//
// A run is one prompt on one session: fresh (`new_session`), continued
// (`switch_session` to a file), or branched (`fork` at an entry of the
// current session). Runs on one process are serialized; a process idle for
// a while is closed; a process that dies is replaced on the next run.

'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const fsp = fs.promises;
const GUARD = path.join(__dirname, 'pi-guard.mjs');
const IDLE_MS = Number(process.env.TD_AGENT_IDLE_MS) || 10 * 60 * 1000; // a Pi process (session or catalog) retires after this long without a listener
const RESPONSE_MS = 30 * 1000;
const { locate, childEnv: envWith } = require('./where.cjs');
const EXTRA_HOMES = [path.join(os.homedir(), '.pi', 'bin')];   // pi's own home, on top of the usual ones (see where.cjs)

/** The pi binary and the directories walked to find it (PATH, the login shell's PATH, the usual homes). */
let located = null;
const findPi = () => (located ??= locate('pi', EXTRA_HOMES));
/** PATH for the child: the shell's plus the usual homes, so Pi's own bash tool finds git, node and friends even under a Finder launch. */
const childEnv = () => envWith(EXTRA_HOMES);

class PiProcess {
  constructor(bin, cwd, opts) {
    this.cwd = cwd;
    this.log = opts.log || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.dead = false;
    this.busy = Promise.resolve();
    this.listener = null;       // the run currently receiving events
    this.openDialogs = new Set(); // confirm questions forwarded to the canvas, not yet answered
    this.idleTimer = null;
    // extra extensions for development and tests (colon-separated paths)
    const extra = (process.env.TD_PI_EXTRA_EXTENSIONS || '').split(':').filter(Boolean).flatMap((e) => ['-e', e]);
    const args = ['--mode', 'rpc', ...(opts.noSession ? ['--no-session'] : ['-e', GUARD, ...extra])];
    this.proc = spawn(bin, args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => this.feed(d.toString()));
    this.proc.stderr.on('data', (d) => this.log('[pi stderr] ' + d.toString().trim().slice(0, 400)));
    this.proc.on('error', (e) => { this.log('[pi] spawn error: ' + e.message); this.die('spawn error: ' + e.message); });
    this.proc.on('exit', (code, signal) => this.die(`pi exited (${signal || code})`));
    this.touch();
  }

  touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (!this.listener) this.close(); }, IDLE_MS);
  }

  feed(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.log('[pi] non-JSON line: ' + line.slice(0, 120)); continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.type === 'response') {
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (p) { this.pending.delete(msg.id); p(msg); }
      return;
    }
    if (msg.type === 'extension_ui_request') {
      // a question for the person — confirm, select, input, editor — goes to
      // the run as one `question` event; the canvas shows it on the node and
      // answers through `answer`. Fire-and-forget notices (notify, status,
      // widget, title) are not questions and get no answer.
      const method = String(msg.method ?? '');
      const KINDS = { confirm: 'confirm', select: 'select', input: 'input', editor: 'editor' };
      if (KINDS[method] && this.listener) {
        this.openDialogs.add(String(msg.id));
        // the guard appends a structured tail (paths, a directory to offer)
        // after U+241F; the person sees only the text before it
        const raw = String(msg.message ?? '');
        const cut = raw.indexOf('\u241F');
        let extra = {};
        if (cut >= 0) { try { extra = JSON.parse(raw.slice(cut + 1)); } catch { extra = {}; } }
        this.listener({
          type: 'question', kind: KINDS[method], id: msg.id, title: msg.title ?? '', message: cut >= 0 ? raw.slice(0, cut) : raw,
          options: Array.isArray(msg.options) ? msg.options.map(String) : [],
          placeholder: typeof msg.placeholder === 'string' ? msg.placeholder : null,
          prefill: typeof msg.prefill === 'string' ? msg.prefill : null,
          paths: Array.isArray(extra.paths) ? extra.paths : [], suggest: typeof extra.suggest === 'string' ? extra.suggest : null,
        });
        return;
      }
      if (KINDS[method]) {
        // nobody is listening: the dialog resolves to its default at once
        this.write({ type: 'extension_ui_response', id: msg.id, cancelled: true });
      }
      return;
    }
    this.listener?.(msg);
  }

  write(obj) {
    try { this.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  /** Withdraw every question still waiting on the canvas: Pi resolves each
   *  with its default at once, so nothing dangles after a stop. */
  withdrawDialogs() {
    for (const id of this.openDialogs) this.write({ type: 'extension_ui_response', id, cancelled: true });
    this.openDialogs.clear();
  }

  send(cmd, timeoutMs = RESPONSE_MS) {
    if (this.dead) return Promise.reject(new Error('pi process is gone'));
    const id = String(this.nextId++);
    this.touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`pi did not answer ${cmd.type} in ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.success === false) reject(new Error(msg.error || `pi refused ${cmd.type}`));
        else resolve(msg.data);
      });
      if (!this.write({ id, ...cmd })) { clearTimeout(timer); this.pending.delete(id); reject(new Error('pi stdin closed')); }
    });
  }

  /** Runs `fn` when no other run holds this process. */
  exclusive(fn) {
    const turn = this.busy.then(fn, fn);
    this.busy = turn.catch(() => {});
    return turn;
  }

  die(reason) {
    if (this.dead) return;
    this.dead = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const p of this.pending.values()) p({ type: 'response', success: false, error: reason });
    this.pending.clear();
    this.listener?.({ type: 'process_exit', reason });
    this.listener = null;
    this.onExit(this);
  }

  close() {
    if (this.dead) return;
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}

const { snapshotDir, diffSnapshots } = require('./fs-diff.cjs');

const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');

function createPiRuntime({ log } = {}) {
  const say = log || (() => {});
  const procs = new Map();     // cwd → PiProcess
  const runs = new Map();      // runId → { proc, abort() }
  let binPromise = null;

  const bin = () => {
    if (!binPromise) binPromise = findPi().then((r) => { if (!r.path) { located = null; binPromise = null; } return r.path; });
    return binPromise;
  };
  /** Where the lookup walked, for the picker's "not found" note. */
  const searched = async () => (await findPi()).searched;
  // Pi's thinking levels in its own words, from its own `--help`
  // (`--thinking <level>  Set thinking level: off, minimal, …`); read once
  let levelsPromise = null;
  const levelsOf = (b) => {
    if (!levelsPromise) levelsPromise = new Promise((resolve) => {
      execFile(b, ['--help'], { env: childEnv(), timeout: 8000, maxBuffer: 1 << 20 }, (_err, stdout) => {
        const m = String(stdout || '').match(/--thinking[^\n]*?level:\s*([a-z0-9_, -]+)/i);
        resolve(m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []);
      });
    });
    return levelsPromise;
  };

  async function processFor(cwd) {
    const live = procs.get(cwd);
    if (live && !live.dead) return live;
    const b = await bin();
    if (!b) throw new Error('pi is not installed (no `pi` on PATH or in the usual places)');
    const p = new PiProcess(b, cwd, { log: say, onExit: (dead) => { if (procs.get(cwd) === dead) procs.delete(cwd); } });
    procs.set(cwd, p);
    return p;
  }

  const modelEntry = (m) => ({
    provider: m.provider, id: m.id, name: m.name || m.id,
    reasoning: !!m.reasoning, vision: Array.isArray(m.input) && m.input.includes('image'),
  });

  return {
    /** Where pi is, or null. */
    available: () => bin(),

    /** Pi's configured models and its current default, asked of a
     *  sessionless process in the home directory. */
    async models() {
      const b = await bin();
      if (!b) return { installed: false, models: [], default: null, searched: await searched() };
      const key = '\0catalog';
      let p = procs.get(key);
      if (!p || p.dead) { p = new PiProcess(b, os.homedir(), { log: say, noSession: true, onExit: (d) => { if (procs.get(key) === d) procs.delete(key); } }); procs.set(key, p); }
      return p.exclusive(async () => {
        const [cat, state, levels] = await Promise.all([p.send({ type: 'get_available_models' }), p.send({ type: 'get_state' }), levelsOf(b)]);
        const defaultEffort = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null;
        const models = (cat?.models ?? []).map((m) => ({ ...modelEntry(m), efforts: m.reasoning ? levels : [], defaultEffort: m.reasoning ? defaultEffort : null }));
        const cur = state?.model ? `${state.model.provider}/${state.model.id}` : null;
        return { installed: true, models, default: cur && models.some((m) => `${m.provider}/${m.id}` === cur) ? cur : (models[0] ? `${models[0].provider}/${models[0].id}` : null), thinkingLevel: state?.thinkingLevel ?? null };
      });
    },

    /**
     * One prompt on one session. `onEvent` receives Pi's session events as
     * they come, plus the shell's own: `session` (which session this run
     * writes to, before the prompt), `run_end` (with the final text), and
     * `run_error`. Resolves with the runId as soon as the run is accepted.
     */
    async run(req, onEvent) {
      const cwd = String(req.cwd || '');
      if (!cwd || !path.isAbsolute(cwd)) throw new Error('run needs an absolute cwd');
      await fsp.mkdir(cwd, { recursive: true });
      const runId = randomUUID();
      const proc = await processFor(cwd);
      const emit = (event) => { try { onEvent({ runId, event }); } catch { /* renderer gone */ } };
      const aborter = { aborted: false, started: false };
      // stopping a run still waiting its turn stops that run: the process is at work on another's, which is not touched
      runs.set(runId, { proc, abort: () => { aborter.aborted = true; if (!aborter.started) return; proc.withdrawDialogs(); proc.send({ type: 'abort' }).catch(() => {}); } });

      void proc.exclusive(async () => {
        if (aborter.aborted) { emit({ type: 'run_end', text: '', how: 'aborted' }); runs.delete(runId); return; }
        aborter.started = true;
        let text = '';
        let ended;
        const finished = new Promise((resolve) => { ended = resolve; });
        // a turn that produces nothing for a long while — a command waiting
        // on stdin, a stuck process — is stopped, with the reason on the node;
        // a question waiting on the person does not count as silence
        const IDLE = Number(process.env.TD_AGENT_IDLE_MS) || 10 * 60 * 1000;
        let lastEvent = Date.now();
        let waitingOnPerson = false;
        const watchdog = setInterval(() => {
          if (waitingOnPerson || Date.now() - lastEvent < IDLE) return;
          emit({ type: 'run_error', message: `no activity for ${IDLE >= 60000 ? Math.round(IDLE / 60000) + ' min' : Math.round(IDLE / 1000) + ' s'}; the turn was stopped` });
          proc.withdrawDialogs();
          proc.send({ type: 'abort' }).catch(() => {});
          setTimeout(() => ended('idle'), 5000);
        }, 15000);
        proc.listener = (event) => {
          lastEvent = Date.now();
          if (event.type === 'question') waitingOnPerson = true;
          if (event.type === 'question_answered') waitingOnPerson = false;
          if (event.type === 'message_end' && event.message?.role === 'assistant') text = textOf(event.message) || text;
          if (event.type === 'process_exit') { emit({ type: 'run_error', message: event.reason }); ended('exit'); return; }
          emit(event);
          if (event.type === 'agent_end') ended('end');
        };
        try {
          if (req.sessionPath) await proc.send({ type: 'switch_session', sessionPath: String(req.sessionPath) });
          if (req.forkEntryId) await proc.send({ type: 'fork', entryId: String(req.forkEntryId) });
          else if (!req.sessionPath) await proc.send({ type: 'new_session' });
          if (req.model && typeof req.model === 'object' && req.model.provider && req.model.id) await proc.send({ type: 'set_model', provider: req.model.provider, modelId: req.model.id });
          // only a level Pi itself lists; an explicit thinkingLevel still wins
          const level = req.thinkingLevel || (req.effort && (await levelsOf(await bin())).includes(req.effort) ? req.effort : null);
          if (level) await proc.send({ type: 'set_thinking_level', level });
          const state = await proc.send({ type: 'get_state' });
          emit({ type: 'session', effort: typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null, sessionId: state?.sessionId ?? null, sessionFile: state?.sessionFile ?? null, model: state?.model ? { provider: state.model.provider, id: state.model.id, name: state.model.name } : null, cwd });
          const before = await snapshotDir(cwd).catch(() => null);
          if (aborter.aborted) { ended('aborted'); }
          else {
            // the prompt's response may follow the whole turn; the end is read from events
            proc.send({ type: 'prompt', message: String(req.prompt ?? ''), ...(Array.isArray(req.images) && req.images.length ? { images: req.images } : {}) }, 24 * 60 * 60 * 1000).catch((e) => { emit({ type: 'run_error', message: e.message }); ended('error'); });
          }
          const how = await finished;
          if (before) {
            const after = await snapshotDir(cwd).catch(() => null);
            if (after) {
              const d = diffSnapshots(before, after);
              if (d.changed.length || d.added.length || d.removed.length || d.truncated) emit({ type: 'fs_changes', ...d });
            }
          }
          emit({ type: 'run_end', text, how });
        } catch (e) {
          emit({ type: 'run_error', message: e instanceof Error ? e.message : String(e) });
          emit({ type: 'run_end', text, how: 'error' });
        } finally {
          clearInterval(watchdog);
          proc.withdrawDialogs();
          proc.listener = null;
          proc.touch();
          runs.delete(runId);
        }
      });
      return runId;
    },

    abort(runId) {
      const r = runs.get(runId);
      if (!r) return false;
      r.abort();
      return true;
    },

    /**
     * The person's answer to a question of a running turn:
     * { confirmed } for a confirm, { value } for select/input/editor,
     * { cancelled: true } to withdraw (the dialog's default applies).
     */
    answer(runId, requestId, response) {
      const r = runs.get(runId);
      if (!r) return false;
      const id = String(requestId);
      const a = response && typeof response === 'object' ? response : { confirmed: !!response };
      const wire = a.cancelled ? { type: 'extension_ui_response', id, cancelled: true }
        : typeof a.value === 'string' ? { type: 'extension_ui_response', id, value: a.value }
        : { type: 'extension_ui_response', id, confirmed: !!a.confirmed };
      const ok = r.proc.write(wire);
      r.proc.openDialogs.delete(id);
      if (ok) r.proc.listener?.({ type: 'question_answered', id, outcome: a.cancelled ? 'cancelled' : typeof a.value === 'string' ? 'answered' : (a.confirmed ? 'allowed-once' : 'rejected'), value: typeof a.value === 'string' ? a.value : null });
      return ok;
    },

    shutdown() {
      for (const p of procs.values()) p.close();
      procs.clear();
    },
  };
}

module.exports = { createPiRuntime, findPi };
