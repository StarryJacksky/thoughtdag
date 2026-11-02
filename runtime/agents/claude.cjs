// Claude Code as an agent runtime: one `claude -p` process per turn, spoken
// to in stream-json both ways. The turn's text and thinking arrive as
// content-block deltas, tool calls as tool_use blocks with their
// tool_result, permission prompts as control requests answered on stdin
// (`--permission-prompt-tool stdio`), the end as a result message. A session
// continues with `--resume`, branches with `--fork-session`. Claude Code
// keeps its session files under ~/.claude/projects, its login and its model
// aliases; the shell only asks. Same event kinds as the other runtimes.
'use strict';

const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { snapshotDir, diffSnapshots } = require('./fs-diff.cjs');
const { probeClaude, versionOf, helpOf, flagsIn, withoutHostSession, READING_TOOLS } = require('./claude-capabilities.cjs');

const fsp = fs.promises;
const { locate, childEnv: envWith } = require('./where.cjs');
/** Where the desktop app keeps the CLI it brings with it: <version>/<build>/claude.app/Contents/MacOS, newest version first. */
function claudeAppDirs(home = os.homedir()) {
  const root = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  const parts = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
  const newer = (a, b) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0); return 0; };
  try {
    return fs.readdirSync(root).sort(newer).flatMap((version) => fs.readdirSync(path.join(root, version)).map((build) => path.join(root, version, build, 'claude.app', 'Contents', 'MacOS')));
  } catch { return []; }
}
const EXTRA_HOMES = [path.join(os.homedir(), '.claude', 'local'), ...claudeAppDirs()];   // the CLI's own install location, then the desktop app's, on top of the usual ones

/** The claude binary and the directories walked to find it (see where.cjs). */
let located = null;
const findClaude = () => (located ??= locate('claude', EXTRA_HOMES));
const childEnv = () => withoutHostSession(envWith(EXTRA_HOMES));

/** Claude Code has no model list; its aliases resolve to the newest model
 *  of each family inside the CLI, so they never go stale. The CLI's own
 *  "default" is not offered: which model it means lives in the CLI's settings
 *  and can change under the person, so the picker names families only. */
/** The effort levels a CLI accepts, in its own words, from its help (the
 *  `--effort <level>` entry lists them in parentheses), so a CLI that adds a
 *  level shows it without a change here. Empty when it has no such flag. */
function effortsIn(help) {
  const at = help.indexOf('--effort');
  if (at < 0) return [];
  const next = help.indexOf('\n  --', at + 1);
  const m = help.slice(at, next > 0 ? next : undefined).match(/\(([a-z0-9_, \n-]+)\)/i);
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
}

const MODELS = [
  { provider: 'claude-code', id: 'fable', name: 'Fable', reasoning: true, vision: true },
  { provider: 'claude-code', id: 'opus', name: 'Opus', reasoning: true, vision: true },
  { provider: 'claude-code', id: 'sonnet', name: 'Sonnet', reasoning: true, vision: true },
  { provider: 'claude-code', id: 'haiku', name: 'Haiku', reasoning: true, vision: true },
];

/** The effort a turn ran at, as the transcript records it on every
 *  assistant entry (`effort`) — the CLI's own setting when the canvas named none. */
async function turnEffortOf(file) {
  if (!file) return null;
  try {
    const lines = (await fsp.readFile(file, 'utf8')).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"effort"')) continue;
      try { const o = JSON.parse(lines[i]); if (o.type === 'assistant' && typeof o.effort === 'string') return o.effort; } catch { /* torn line */ }
    }
  } catch { /* no file */ }
  return null;
}

/** The CLI's configured effort (`effortLevel` in ~/.claude/settings.json), when set. */
async function configuredEffort() {
  try { const s = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')); return typeof s.effortLevel === 'string' ? s.effortLevel : null; } catch { return null; }
}

/** ~/.claude/projects/<slug>/<sessionId>.jsonl. The slug is the cwd with
 *  '/' and '.' turned into '-', but a long path is cut and given a short
 *  suffix by Claude Code itself — so the file is found by its id across the
 *  project directories when the computed name is not there. */
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
async function sessionFileFor(cwd, sessionId) {
  const guess = path.join(PROJECTS_DIR, cwd.replace(/[/.]/g, '-'), `${sessionId}.jsonl`);
  if (await fsp.access(guess).then(() => true, () => false)) return guess;
  try {
    const dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(PROJECTS_DIR, d.name, `${sessionId}.jsonl`);
      if (await fsp.access(candidate).then(() => true, () => false)) return candidate;
    }
  } catch { /* no projects yet */ }
  return null;
}
// the session id is the file's name; a directory on the way may carry a
// UUID of its own (a project path that names a session), so take the LAST
const sessionIdOf = (sessionPath) => { const all = String(sessionPath ?? '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi); return all && all.length ? all[all.length - 1] : null; };

/** The guard file the canvas writes per working directory, as a permission
 *  mode: ask → the CLI's default (it asks before edits and commands), auto →
 *  its classifier decides and asks only what it holds risky, allow → nothing
 *  asked. Questions the model puts to the person reach the canvas in all three. */
async function permissionModeFor(cwd) {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(cwd, '.thoughtdag', 'guard.json'), 'utf8'));
    if (raw?.mode === 'allow') return 'bypassPermissions';
    if (raw?.mode === 'auto') return 'auto';
  } catch { /* default */ }
  return 'default';
}

/** A run that cannot go as asked: said to the person under a code, and nothing is sent in its place. */
class RunRefused extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const RESEARCH_PROMPT = 'You answer from the inputs you are given and nothing else. Your only tools read files in your working directory, which holds those inputs.';
/** What this CLI cannot run a turn without. */
const NEEDED = ['--output-format', '--input-format', '--verbose', '--permission-mode'];
const MISSING_SESSION = /no conversation found/i;
const BUSY_SESSION = /already in use|\bis busy\b|\blocked\b/i;
const UNKNOWN_OPTION = /unknown option/i;
/** What the CLI said on its way out, as a code for the person: a session gone or in use is not a failure of the turn. */
function codeOf(said) {
  if (MISSING_SESSION.test(said)) return 'session-missing';
  if (BUSY_SESSION.test(said)) return 'session-busy';
  if (UNKNOWN_OPTION.test(said)) return 'cli-unsupported';
  return null;
}

function createClaudeRuntime({ log, find = findClaude, probe = probeClaude } = {}) {
  const say = log || (() => {});
  const runs = new Map();     // runId → state
  let binPromise = null;
  const bin = () => {
    if (!binPromise) binPromise = find().then((r) => { if (!r.path) { located = null; binPromise = null; } return r.path; });
    return binPromise;
  };
  /** Where the lookup walked, for the picker's "not found" note. */
  const searched = async () => (await find()).searched;

  // The CLI's `--help`, the one source of what it accepts: read once, until a new version, unless it gave none.
  let helpPromise = null;
  function helpFor(b) {
    if (helpPromise) return helpPromise;
    const asked = helpOf(b, childEnv());
    helpPromise = asked;
    asked.then((help) => { if (!help && helpPromise === asked) helpPromise = null; }, () => { if (helpPromise === asked) helpPromise = null; });
    return asked;
  }
  const effortsOf = async (b) => effortsIn(await helpFor(b));

  // What this version can do. A report stands while the binary says the same version; a new one is probed for.
  let probed = null;
  async function capabilities() {
    const b = await bin();
    if (!b) return null;
    const version = await versionOf(b, childEnv());
    if (probed && probed.binary === b && probed.version === version) return probed.report;
    if (probed) helpPromise = null;
    const report = probe(b);
    probed = { binary: b, version, report };
    report.catch(() => { if (probed?.report === report) probed = null; });
    return report;
  }

  return {
    available: () => bin(),

    capabilities,

    async models() {
      const b = await bin();
      if (!b) return { installed: false, models: [], default: null, searched: await searched() };
      const [efforts, defaultEffort] = await Promise.all([effortsOf(b), configuredEffort()]);
      return { installed: true, models: MODELS.map((m) => ({ ...m, efforts, defaultEffort })), default: 'claude/claude-code/opus' };
    },

    async run(req, onEvent) {
      const cwd = String(req.cwd || '');
      if (!cwd || !path.isAbsolute(cwd)) throw new Error('run needs an absolute cwd');
      await fsp.mkdir(cwd, { recursive: true });
      const b = await bin();
      if (!b) throw new Error('claude is not installed (no `claude` on PATH or in the usual places)');
      const runId = randomUUID();
      const emit = (event) => { try { onEvent({ runId, event }); } catch { /* renderer gone */ } };
      const state = { runId, proc: null, asks: new Map(), text: '', final: null, sessionId: null, lastEntry: null, turnStatus: null, heard: '', waiting: false, ended: false, aborted: false,
        // what this conversation already allowed for good (see README: `rule`)
        allowRules: new Set(Array.isArray(req.allowRules) ? req.allowRules.filter((s) => typeof s === 'string' && s.startsWith('claude:')) : []) };
      runs.set(runId, state);

      void (async () => {
        const IDLE = Number(process.env.TD_AGENT_IDLE_MS) || 10 * 60 * 1000;
        let lastEvent = Date.now();
        const mark = (event) => { lastEvent = Date.now(); if (event.type === 'question') state.waiting = true; if (event.type === 'question_answered') state.waiting = false; emit(event); };
        let watchdog = null;
        const before = await snapshotDir(cwd).catch(() => null);
        // stopped while it was being prepared: nothing is started, and nothing is sent
        const STOPPED = Symbol('stopped');
        const goOn = () => { if (state.aborted) throw STOPPED; };
        let workdir = cwd;
        let ownFolder = null;
        try {
          goOn();
          const researching = req.mode === 'research';
          if (researching) {
            const known = (await capabilities())?.capabilities ?? {};
            if (req.sessionPath || !['readOnlyRoots', 'networkRestriction', 'autoContextControl'].every((c) => known[c] === 'supported')) throw new RunRefused('research-unverified', 'this version of claude is not known to keep a run to its inputs');
          }
          const resumeId = req.sessionPath ? sessionIdOf(req.sessionPath) : null;
          // a branch through a turn cannot be had: --fork-session copies all of the history, which is another thing, asked for as itself
          if (resumeId && req.forkEntryId) throw new RunRefused('fork-unsupported', 'claude cannot branch a session at a turn');
          // research runs where its file tools reach nothing but its inputs: its materials, or an empty folder of its own
          if (researching) {
            if (req.readRoot !== undefined) {
              const root = path.resolve(cwd, String(req.readRoot));
              const within = path.relative(cwd, root);
              if (path.isAbsolute(String(req.readRoot)) || !within || within.startsWith('..') || !(await fsp.stat(root).then((st) => st.isDirectory(), () => false))) throw new RunRefused('research-unverified', 'the folder this run is to read is not one of its own');
              workdir = root;
            } else {
              ownFolder = await fsp.mkdtemp(path.join(os.tmpdir(), 'tdag-research-'));
              workdir = ownFolder;
            }
          }
          const mode = researching ? 'dontAsk' : await permissionModeFor(cwd);
          const model = req.model && typeof req.model === 'object' && req.model.id && req.model.id !== 'default' ? req.model.id : null;
          // what this version lists: with no help to read, nothing that a run can do without is sent
          const help = await helpFor(b);
          goOn();
          const flags = flagsIn(help);
          const lists = (flag) => flags.has(flag);
          if (help && !NEEDED.every(lists)) throw new RunRefused('cli-unsupported', `this version of claude lacks ${NEEDED.filter((f) => !lists(f)).join(', ')}`);
          // the prompt channel stays open in every mode: with nothing to
          // approve, AskUserQuestion still comes through it
          const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', ...(lists('--include-partial-messages') ? ['--include-partial-messages'] : []), '--permission-mode', mode, '--permission-prompt-tool', 'stdio'];
          if (model && (lists('--model') || !help)) args.push('--model', model);
          // only a level the CLI itself lists; anything else means its default
          if (req.effort && (await effortsOf(b)).includes(req.effort)) args.push('--effort', req.effort);
          // the default system prompt brings what the CLI knows of the person and the machine: research has its own, which says only what the run is
          if (researching) args.push('--restricted', '--safe-mode', '--strict-mcp-config', '--tools', READING_TOOLS.join(','), '--system-prompt', RESEARCH_PROMPT);
          const inheritsHistory = !!(resumeId && req.forkSession);
          if (resumeId) { args.push('--resume', resumeId); if (inheritsHistory) args.push('--fork-session'); }
          goOn();
          const proc = spawn(b, args, { cwd: workdir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
          state.proc = proc;
          proc.stdin.on('error', () => {});
          let buf = '';
          const finished = new Promise((resolve) => {
            const done = (how) => { if (state.ended) return; state.ended = true; resolve(how); };
            proc.stdout.on('data', (d) => {
              buf += d.toString();
              let i;
              while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                if (!line.trim()) continue;
                let m; try { m = JSON.parse(line); } catch { continue; }
                handle(m, done);
              }
            });
            proc.stderr.on('data', (d) => { const said = d.toString(); state.heard = (state.heard + said).slice(-2000); say('[claude stderr] ' + said.trim().slice(0, 400)); });
            proc.on('error', (e) => { mark({ type: 'run_error', message: 'spawn error: ' + e.message }); done('error'); });
            proc.on('exit', (code, signal) => {
              if (state.ended) return;
              if (!state.aborted && code) { const said = state.heard.trim(); const why = codeOf(said); mark({ type: 'run_error', message: said.slice(-400) || `claude exited (${signal || code})`, ...(why ? { code: why } : {}) }); }
              done(state.aborted ? 'aborted' : (code ? 'error' : 'end'));
            });
          });
          watchdog = setInterval(() => {
            if (state.waiting || Date.now() - lastEvent < IDLE) return;
            mark({ type: 'run_error', message: `no activity for ${IDLE >= 60000 ? Math.round(IDLE / 60000) + ' min' : Math.round(IDLE / 1000) + ' s'}; the turn was stopped` });
            state.aborted = true; try { proc.kill(); } catch { /* gone */ }
          }, 15000);

          const handle = (m, done) => {
            switch (m.type) {
              case 'system':
                if (m.subtype === 'init') {
                  // research comes up with the tools it was given and no others, or it does not go on
                  if (researching && Array.isArray(m.tools) && !m.tools.every((t) => READING_TOOLS.includes(t))) {
                    mark({ type: 'run_error', code: 'research-unverified', message: `the run came up with tools it was not given: ${m.tools.filter((t) => !READING_TOOLS.includes(t)).join(', ')}` });
                    try { proc.kill(); } catch { /* gone */ }
                    done('error');
                    break;
                  }
                  state.sessionId = m.session_id;
                  // the file appears once the first lines are written; the
                  // completion re-emits the session with its real path
                  mark({ type: 'session', sessionId: m.session_id, sessionFile: null, model: model ? { provider: 'claude-code', id: model, name: model } : null, cwd: workdir });
                } else if (m.subtype === 'permission_denied') {
                  mark({ type: 'tool_execution_end', toolCallId: m.tool_use_id ?? '', toolName: m.tool_name ?? 'tool', result: 'permission denied', isError: true });
                }
                break;
              case 'stream_event': {
                const ev = m.event ?? {};
                if (ev.type === 'content_block_delta') {
                  const d = ev.delta ?? {};
                  if (d.type === 'text_delta' && d.text) { state.text += d.text; mark({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: d.text } }); }
                  else if (d.type === 'thinking_delta' && d.thinking) mark({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: d.thinking } });
                }
                break;
              }
              case 'assistant':
                // the alias resolved to a real model inside the CLI; the final session event carries it
                if (!state.resolvedModel && typeof m.message?.model === 'string') state.resolvedModel = m.message.model;
                if (typeof m.uuid === 'string') state.lastEntry = m.uuid;
                for (const b of m.message?.content ?? []) if (b.type === 'tool_use') mark({ type: 'tool_execution_start', toolCallId: b.id, toolName: b.name, args: b.input ?? {} });
                break;
              case 'user':
                for (const b of m.message?.content ?? []) if (b.type === 'tool_result') mark({ type: 'tool_execution_end', toolCallId: b.tool_use_id, toolName: '', result: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null).slice(0, 4000), isError: !!b.is_error });
                break;
              case 'control_request': {
                const r = m.request ?? {};
                if (r.subtype !== 'can_use_tool') { write(proc, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'unsupported request' } }); break; }
                const id = `q-${m.request_id}`;
                const input = r.input ?? {};
                // the model's own questions for the person: one form, answered
                // through the same channel — the answers ride back in the tool's
                // input, keyed by each question's text (a skip is a refusal the
                // model reads as "not answered")
                if (r.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
                  const qs = input.questions.filter((q) => q && typeof q.question === 'string');
                  state.asks.set(id, (answer) => {
                    const given = Array.isArray(answer?.answers) ? answer.answers : null;
                    if (!given || answer?.cancelled) {
                      write(proc, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: 'The person skipped these questions without answering.' } } });
                      mark({ type: 'question_answered', id, outcome: 'cancelled', value: null });
                      return;
                    }
                    const answers = {};
                    qs.forEach((q, i) => {
                      const a = given.find((x) => x && x.id === String(i));
                      if (!a) return;
                      const own = typeof a.custom === 'string' && a.custom.trim() ? a.custom.trim() : null;
                      const picked = (Array.isArray(a.selected) ? a.selected : []).filter((x) => typeof x === 'string');
                      if (q.multiSelect) { const all = own ? [...picked, own] : picked; if (all.length) answers[q.question] = all; }
                      else if (own || picked[0]) answers[q.question] = own ?? picked[0];
                    });
                    write(proc, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: { ...input, answers } } } });
                    mark({ type: 'question_answered', id, outcome: 'answered', value: Object.entries(answers).map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(', ') : v}`).join('; ') || null });
                  });
                  mark({
                    type: 'question', kind: 'form', id, title: 'AskUserQuestion', message: qs.map((q) => q.question).join('\n'),
                    questions: qs.map((q, i) => ({
                      id: String(i), question: q.question, ...(typeof q.header === 'string' ? { header: q.header } : {}),
                      options: (Array.isArray(q.options) ? q.options : []).filter((o) => o && typeof o.label === 'string').map((o) => ({ label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) })),
                      multiSelect: !!q.multiSelect, custom: true,
                    })),
                    options: [], placeholder: null, prefill: null, paths: [], suggest: null,
                  });
                  break;
                }
                const line = typeof input.command === 'string' ? input.command : (input.file_path ?? input.path ?? JSON.stringify(input).slice(0, 200));
                // the CLI's own "don't ask again" suggestion names what a standing
                // allowance covers; sent back scoped to the session, never to settings
                const suggest = (Array.isArray(r.permission_suggestions) ? r.permission_suggestions : []).find((s) => s && s.type === 'addRules' && Array.isArray(s.rules) && s.rules.length);
                const rule = suggest ? 'claude:' + JSON.stringify(suggest.rules.map((x) => ({ toolName: x.toolName, ...(x.ruleContent ? { ruleContent: x.ruleContent } : {}) }))) : null;
                const allow = (forSession) => write(proc, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: input, ...(forSession && suggest ? { updatedPermissions: [{ ...suggest, destination: 'session' }] } : {}) } } });
                const title = `${r.tool_name ?? 'tool'} needs approval`;
                if (rule && state.allowRules.has(rule)) {
                  allow(true);
                  mark({ type: 'question_answered', id, outcome: 'allowed-session', value: null, auto: true, title, message: line, rule });
                  break;
                }
                state.asks.set(id, (answer) => {
                  const yes = !!answer?.confirmed;
                  const forSession = yes && answer?.scope === 'session' && !!rule;
                  if (forSession) state.allowRules.add(rule);
                  if (yes) allow(forSession); else write(proc, { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'deny', message: 'the person did not allow this step' } } });
                  mark({ type: 'question_answered', id, outcome: yes ? (forSession ? 'allowed-session' : 'allowed-once') : 'rejected', value: null, ...(forSession ? { rule } : {}) });
                });
                mark({ type: 'question', kind: 'confirm', id, rule, title, message: [line, r.description].filter(Boolean).join('\n'), options: [], placeholder: null, prefill: null, paths: [], suggest: null });
                break;
              }
              case 'result': {
                // a turn that failed may still say "success": `is_error` is what says so, and what it said is not an answer
                const failed = !!m.is_error || (!!m.subtype && m.subtype !== 'success');
                if (failed) {
                  state.text = '';
                  state.final = null;
                  state.turnStatus = 'failed';
                  // the reason of a session not found comes on stderr, a moment after
                  setTimeout(() => {
                    const said = (typeof m.result === 'string' && m.result) || state.heard.trim() || String(m.subtype ?? 'the turn failed');
                    const why = codeOf(said);
                    mark({ type: 'run_error', message: said.slice(-400), ...(why ? { code: why } : {}) });
                    done('error');
                  }, m.result ? 0 : 50);
                  break;
                }
                state.final = typeof m.result === 'string' ? m.result : null;
                state.turnStatus = 'completed';
                done('end');
                break;
              }
              default: break;
            }
          };

          goOn();
          // the prompt goes in as one user message; stdin stays open for answers
          const content = [{ type: 'text', text: String(req.prompt ?? '') }];
          for (const img of Array.isArray(req.images) ? req.images : []) if (img && typeof img.data === 'string') content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } });
          write(proc, { type: 'user', message: { role: 'user', content } });

          const how = await finished;
          // let the CLI finish writing its transcript: it exits on its own
          // after the result; a kill is only the fallback
          await new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode) return resolve(); const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } resolve(); }, 8000); proc.once('exit', () => { clearTimeout(t); resolve(); }); });
          // what a later run may go on from: the entry of a turn that really finished
          if (state.sessionId) mark({ type: 'binding', threadId: null, nativeSessionId: state.sessionId, inheritsHistory, turnStatus: state.turnStatus ?? (how === 'aborted' ? 'interrupted' : how === 'end' ? 'completed' : 'failed'), turnId: state.lastEntry, lastCompletedTurnId: (state.turnStatus === 'completed' || (!state.turnStatus && how === 'end')) ? state.lastEntry : null });
          if (state.sessionId) {
            const file = await sessionFileFor(workdir, state.sessionId);
            const ran = await turnEffortOf(file);
            mark({ type: 'session', effort: ran, sessionId: state.sessionId, sessionFile: file, model: { provider: 'claude-code', id: model ?? 'default', name: model ?? 'default', ...(state.resolvedModel ? { resolved: state.resolvedModel } : {}) }, cwd: workdir });
          }
          if (before) {
            const after = await snapshotDir(cwd).catch(() => null);
            if (after) { const d = diffSnapshots(before, after); if (d.changed.length || d.added.length || d.removed.length || d.truncated) mark({ type: 'fs_changes', ...d }); }
          }
          mark({ type: 'run_end', text: state.final ?? state.text, how });
        } catch (e) {
          if (e === STOPPED) mark({ type: 'run_end', text: state.final ?? state.text, how: 'aborted' });
          else {
            mark({ type: 'run_error', message: e instanceof Error ? e.message : String(e), ...(e instanceof RunRefused ? { code: e.code } : {}) });
            mark({ type: 'run_end', text: state.final ?? state.text, how: 'error' });
          }
        } finally {
          if (watchdog) clearInterval(watchdog);
          if (ownFolder) await fsp.rm(ownFolder, { recursive: true, force: true }).catch(() => {});
          runs.delete(runId);
        }
      })();
      return runId;
    },

    abort(runId) {
      const r = runs.get(runId);
      if (!r) return false;
      r.aborted = true;
      for (const [id, respond] of r.asks) { respond({ confirmed: false }); r.asks.delete(id); }
      try { r.proc?.kill(); } catch { /* gone */ }
      return true;
    },

    answer(runId, requestId, response) {
      const r = runs.get(runId);
      const respond = r?.asks.get(String(requestId));
      if (!respond) return false;
      r.asks.delete(String(requestId));
      const a = response && typeof response === 'object' ? response : { confirmed: !!response };
      respond(a.cancelled ? { confirmed: false } : a);
      return true;
    },

    shutdown() { for (const r of runs.values()) { try { r.proc?.kill(); } catch { /* gone */ } } },
  };
}

function write(proc, obj) { try { proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; } }

module.exports = { createClaudeRuntime, findClaude, claudeAppDirs };
