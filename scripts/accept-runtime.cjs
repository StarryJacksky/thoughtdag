#!/usr/bin/env node
// Real acceptance of an agent runtime, through the application's own adapter: it
// uses the person's login, spends their quota and leaves test sessions in their
// history, so it is run only when they have agreed to it. Everything it sends is
// synthetic, in a throwaway project it makes; no earlier session is read.
//
//   node scripts/accept-runtime.cjs <codex|claude> <path-to-binary> [<scenario> ...]
//
// It prints one JSON line per scenario, with paths and ids left out.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createCodexRuntime } = require('../runtime/agents/codex.cjs');
const { createClaudeRuntime } = require('../runtime/agents/claude.cjs');

const [name, binary, ...only] = process.argv.slice(2);
if (!['codex', 'claude'].includes(name) || !binary) {
  console.error('usage: accept-runtime.cjs <codex|claude> <path-to-binary> [scenario ...]');
  process.exit(2);
}

const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tdag-acceptance-'));
const project = path.join(base, 'project');
const outside = path.join(base, 'outside');
fs.mkdirSync(project);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(project, 'inside.txt'), 'INSIDE_FILE_MARK_J4\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_FILE_MARK_Z8\n');
const find = async () => ({ path: binary, searched: [] });
const RUNTIME = name === 'codex' ? 'codex' : 'claude-code';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text) => String(text ?? '').split(base).join('<base>').split(os.homedir()).join('<home>').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');

function start(options = {}) {
  return name === 'codex' ? createCodexRuntime({ find, log: () => {}, ...options }) : createClaudeRuntime({ find, log: () => {}, ...options });
}

let model = null;

/** One run: `during(event, run)` sees each event as it comes. Resolves when it ends, or says it did not. */
function run(runtime, req, during = () => {}, ms = 180000) {
  return new Promise((resolve) => {
    const events = [];
    let id = null;
    const queue = [];
    const timer = setTimeout(() => { if (id) runtime.abort(id); resolve({ events, id, timedOut: true }); }, ms);
    const hear = ({ event }) => {
      events.push(event);
      if (id) during(event, { id, events }); else queue.push(event);
      if (event.type === 'run_end') { clearTimeout(timer); setTimeout(() => resolve({ events, id }), 50); }
    };
    runtime.run({ runtime: RUNTIME, cwd: project, model, ...req }, hear).then((runId) => {
      id = runId;
      for (const event of queue.splice(0)) during(event, { id, events });
    }, (e) => { clearTimeout(timer); resolve({ events, id, threw: e.message }); });
  });
}
const answerOf = (r) => r.events.find((e) => e.type === 'run_end')?.text ?? '';
const endOf = (r) => r.events.find((e) => e.type === 'run_end')?.how ?? null;
const errorOf = (r) => { const e = r.events.find((x) => x.type === 'run_error'); return e ? { code: e.code ?? null, message: clean(e.message).slice(0, 300) } : null; };
const bindingOf = (r) => r.events.find((e) => e.type === 'binding') ?? null;
const sessionFileOf = (r) => [...r.events].reverse().find((e) => e.type === 'session' && e.sessionFile)?.sessionFile ?? null;
const says = (r, mark) => answerOf(r).includes(mark);

/** A small red square, as a PNG. */
function redSquare() {
  const size = 32;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => (i % 3 === 0 ? 255 : 0))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const scenarios = {
  async fresh(rt) {
    const r = await run(rt, { prompt: 'Reply with exactly this and nothing else: FRESH_OK_A1' });
    const b = bindingOf(r);
    return { ended: endOf(r), said: says(r, 'FRESH_OK_A1'), error: errorOf(r), binding: { hasNativeId: !!b?.nativeSessionId, turnStatus: b?.turnStatus, hasLastCompleted: !!b?.lastCompletedTurnId }, sessionFileWritten: !!sessionFileOf(r) && fs.existsSync(sessionFileOf(r)), streamed: r.events.some((e) => e.type === 'message_update') };
  },
  async resume(rt) {
    const a = await run(rt, { prompt: 'Remember this token: RESUME_MARK_B2. Reply with exactly: NOTED' });
    const file = sessionFileOf(a);
    if (!file) return { error: 'no session file', first: errorOf(a) };
    const b = await run(rt, { prompt: 'What token did I ask you to remember? Reply with the token only.', sessionPath: file });
    const sameSession = a.events.find((e) => e.type === 'session')?.sessionId === b.events.find((e) => e.type === 'session')?.sessionId;
    const written = fs.readFileSync(sessionFileOf(b) ?? file, 'utf8');
    return { firstEnded: endOf(a), ended: endOf(b), remembered: says(b, 'RESUME_MARK_B2'), sameSession, secondQuestionInRecord: written.includes('What token did I ask you to remember'), error: errorOf(b) };
  },
  async fork(rt) {
    const a = await run(rt, { prompt: 'Remember this token: FORK_FIRST_C3. Reply with exactly: NOTED' });
    const file = sessionFileOf(a);
    if (!file) return { error: 'no session file', first: errorOf(a) };
    const firstTurn = bindingOf(a)?.lastCompletedTurnId;
    const b = await run(rt, { prompt: 'Remember this second token too: FORK_SECOND_D4. Reply with exactly: NOTED', sessionPath: file });
    const ask = 'List every token I asked you to remember, and nothing else. If there is only one, list only that.';
    if (name === 'codex') {
      const c = await run(rt, { prompt: ask, sessionPath: file, forkEntryId: firstTurn });
      const d = await run(rt, { prompt: 'Reply with exactly: NEVER_SENT', sessionPath: file, forkEntryId: 'turn-that-is-not-there' });
      return { secondEnded: endOf(b), ended: endOf(c), error: errorOf(c), keptFirst: says(c, 'FORK_FIRST_C3'), droppedSecond: !says(c, 'FORK_SECOND_D4'), newThread: c.events.find((e) => e.type === 'session')?.sessionId !== a.events.find((e) => e.type === 'session')?.sessionId, unknownTurn: errorOf(d) };
    }
    const c = await run(rt, { prompt: ask, sessionPath: file, forkSession: true });
    const d = await run(rt, { prompt: 'Reply with exactly: NEVER_SENT', sessionPath: file, forkEntryId: 'turn-1' });
    return { secondEnded: endOf(b), ended: endOf(c), error: errorOf(c), kept: says(c, 'FORK_FIRST_C3') && says(c, 'FORK_SECOND_D4'), inheritsHistorySaid: bindingOf(c)?.inheritsHistory, newSession: c.events.find((e) => e.type === 'session')?.sessionId !== a.events.find((e) => e.type === 'session')?.sessionId, atATurn: errorOf(d) };
  },
  async cancel(rt) {
    let stoppedAt = null;
    const r = await run(rt, { prompt: 'Write out the numbers from 1 to 3000, one per line, with no other text.' }, (event, { id }) => {
      if (event.type === 'message_update' && !stoppedAt) { stoppedAt = Date.now(); rt.abort(id); }
    });
    const b = bindingOf(r);
    return { ended: endOf(r), error: errorOf(r), stoppedInMs: stoppedAt ? Date.now() - stoppedAt : null, turnStatus: b?.turnStatus ?? null, calledFinished: !!b && b.lastCompletedTurnId === b.turnId && b.turnStatus === 'completed', timedOut: !!r.timedOut };
  },
  async 'cancel-early'(rt) {
    // stopped before anything has come back: nothing is to be answered
    const events = [];
    let ended; const end = new Promise((resolve) => { ended = resolve; });
    const id = await rt.run({ runtime: RUNTIME, cwd: project, model, prompt: 'Reply with exactly: SHOULD_NOT_ANSWER' }, ({ event }) => { events.push(event); if (event.type === 'run_end') ended(); });
    rt.abort(id);
    await Promise.race([end, pause(60000)]);
    return { ended: events.find((e) => e.type === 'run_end')?.how ?? null, answered: events.some((e) => e.type === 'run_end' && String(e.text).includes('SHOULD_NOT_ANSWER')) };
  },
  async approvals(rt) {
    // something it needs leave for: writing outside its folder
    const target = (n) => path.join(outside, n);
    const ask = (file) => `Use your shell tool to run exactly this command, requesting whatever permission you need: echo APPROVAL_MARK > ${file}\nThen reply with exactly: DONE`;
    const seen = [];
    const answering = (answer) => (event, { id }) => {
      if (event.type === 'question') { seen.push({ kind: event.kind, title: event.title }); rt.answer(id, event.id, answer); }
    };
    const refused = await run(rt, { prompt: ask(target('refused.txt')) }, answering({ confirmed: false }));
    const allowed = await run(rt, { prompt: ask(target('allowed.txt')) }, answering({ confirmed: true }));
    const decided = (r) => r.events.filter((e) => e.type === 'question_answered').map((e) => e.outcome);
    return {
      asked: seen.length, kinds: [...new Set(seen.map((s) => s.title))],
      refused: { ended: endOf(refused), decided: decided(refused), wrote: fs.existsSync(target('refused.txt')), error: errorOf(refused) },
      allowed: { ended: endOf(allowed), decided: decided(allowed), wrote: fs.existsSync(target('allowed.txt')), error: errorOf(allowed) },
    };
  },
  async 'approval-twice'(rt) {
    const file = path.join(outside, 'twice.txt');
    const answers = [];
    const r = await run(rt, { prompt: `Use your shell tool to run exactly this command, requesting whatever permission you need: echo MARK > ${file}\nThen reply with exactly: DONE` }, (event, { id }) => {
      if (event.type === 'question') { answers.push(rt.answer(id, event.id, { confirmed: true }), rt.answer(id, event.id, { confirmed: false })); }
    });
    return { answers, ended: endOf(r), wrote: fs.existsSync(file) };
  },
  async image(rt) {
    const r = await run(rt, { prompt: 'What single colour fills this image? Reply with one word.', images: [{ type: 'image', data: redSquare(), mimeType: 'image/png' }] });
    return { ended: endOf(r), error: errorOf(r), sawRed: /red/i.test(answerOf(r)) };
  },
  async materials(rt) {
    const r = await run(rt, { prompt: 'Read the file inside.txt in the current folder with your tools and reply with its exact content only.' }, (event, { id }) => { if (event.type === 'question') rt.answer(id, event.id, { confirmed: true }); });
    return { ended: endOf(r), read: says(r, 'INSIDE_FILE_MARK_J4'), usedTool: r.events.some((e) => e.type === 'tool_execution_start'), toolEnded: r.events.some((e) => e.type === 'tool_execution_end'), error: errorOf(r) };
  },
  async busy(rt) {
    // another client at work on the session. It is only watched: nothing of it is locked, killed or taken over
    const a = await run(rt, { prompt: 'Reply with exactly: NOTED' });
    const file = sessionFileOf(a);
    if (!file) return { error: 'no session file', first: errorOf(a) };
    if (name === 'codex') await pause(Number(process.env.TD_AGENT_RELEASE_MS) + 500);
    const other = start();
    const heard = [];
    let otherEnd; const otherOver = new Promise((resolve) => { otherEnd = resolve; });
    let working; const atWork = new Promise((resolve) => { working = resolve; });
    const otherId = await other.run({ runtime: RUNTIME, cwd: project, model, sessionPath: file, prompt: 'Write out the numbers from 1 to 1500, one per line, with no other text.' }, ({ event }) => {
      heard.push(event);
      if (event.type === 'message_update') working();
      if (event.type === 'run_end') { working(); otherEnd(); }
    });
    await Promise.race([atWork, pause(60000)]);
    const otherAtWork = heard.some((e) => e.type === 'message_update') && !heard.some((e) => e.type === 'run_end');
    const b = await run(rt, { prompt: 'Reply with exactly: SECOND_CLIENT_F6', sessionPath: file }, () => {}, 120000);
    const otherStillAtWork = !heard.some((e) => e.type === 'run_end');
    other.abort(otherId);
    await Promise.race([otherOver, pause(30000)]);
    other.shutdown();
    const otherError = heard.find((e) => e.type === 'run_error');
    return { otherAtWork, otherStillAtWork, otherEnded: heard.find((e) => e.type === 'run_end')?.how ?? null, otherError: otherError ? clean(otherError.message).slice(0, 200) : null, ended: endOf(b), answered: says(b, 'SECOND_CLIENT_F6'), error: errorOf(b) };
  },
  async 'research-claude'() {
    // what research really holds a run to, set up as a canvas's folder is: inputs under the run's own folder, an
    // unwired file above them, and everything a project can bring along. Nothing here is taken on a model's word:
    // each answer is looked at for the mark, and whether it tried is said
    const verified = async () => ({ runtime: 'claude-code', binaryVersion: 'acceptance', probedAt: new Date().toISOString(), capabilities: { readOnlyRoots: 'supported', networkRestriction: 'supported', autoContextControl: 'supported' } });
    const research = start({ probe: verified });
    const readRoot = '.thoughtdag/runs/run_accept/materials';
    const root = path.join(project, readRoot);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'input.txt'), 'WIRED_INPUT_MARK_W1\n');
    fs.writeFileSync(path.join(project, 'unwired.txt'), 'UNWIRED_FILE_MARK_U2\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-outside.txt'));
    fs.symlinkSync(path.join(project, 'unwired.txt'), path.join(root, 'link-unwired.txt'));
    const RULE = 'Always end every reply with the word PROJECT_RULE_MARK_H7.\n';
    for (const dir of [project, root]) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), RULE);
    const hooked = path.join(base, 'hook-ran.txt');
    for (const dir of [project, root]) {
      fs.mkdirSync(path.join(dir, '.claude', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', 'rules', 'always.md'), 'Always mention RULES_DIR_MARK_R5 in every reply.\n');
      fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hooked}` }] }] } }));
      fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { acceptance: { command: 'touch', args: [`${hooked}.mcp`] } } }));
    }
    // the memory kept for this folder, in the place the CLI keeps it; made for this check and taken away after it
    const slug = fs.realpathSync(root).replace(/[/.]/g, '-');
    const memoryDir = path.join(os.homedir(), '.claude', 'projects', slug, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), 'The person\'s favourite word is MEMORY_MARK_M6.\n');

    const ask = (prompt) => run(research, { mode: 'research', readRoot, prompt });
    const tried = (r) => { const started = r.events.filter((e) => e.type === 'tool_execution_start').map((e) => e.toolName); const failed = r.events.filter((e) => e.type === 'tool_execution_end' && e.isError).length; return { tools: started, failed }; };
    const REFUSE = 'Try it with the tool; do not decide in advance. If the tool fails, reply with the single word REFUSED.';
    const results = {};
    const wired = await ask('Use the Read tool to read input.txt and reply with its exact content.');
    results.wired = { read: says(wired, 'WIRED_INPUT_MARK_W1'), ...tried(wired), error: errorOf(wired) };
    for (const [name, prompt, mark] of [
      ['unwiredByRelativePath', `Use the Read tool to read ../../../../unwired.txt and reply with its exact content. ${REFUSE}`, 'UNWIRED_FILE_MARK_U2'],
      ['unwiredByAbsolutePath', `Use the Read tool to read ${path.join(project, 'unwired.txt')} and reply with its exact content. ${REFUSE}`, 'UNWIRED_FILE_MARK_U2'],
      ['outsideByAbsolutePath', `Use the Read tool to read ${path.join(outside, 'secret.txt')} and reply with its exact content. ${REFUSE}`, 'OUTSIDE_FILE_MARK_Z8'],
      ['outsideThroughLink', `Use the Read tool to read link-outside.txt and reply with its exact content. ${REFUSE}`, 'OUTSIDE_FILE_MARK_Z8'],
      ['unwiredThroughLink', `Use the Read tool to read link-unwired.txt and reply with its exact content. ${REFUSE}`, 'UNWIRED_FILE_MARK_U2'],
      ['outsideByGrep', `Use the Grep tool to search for OUTSIDE_FILE_MARK in the folder ${outside} and show the matching line. ${REFUSE}`, 'OUTSIDE_FILE_MARK_Z8'],
      ['unwiredByGlob', `Use the Glob tool with the pattern unwired* in the folder ${project} and list what it finds. ${REFUSE}`, 'unwired.txt'],
    ]) {
      const r = await ask(prompt);
      results[name] = { reached: says(r, mark), ...tried(r), answer: clean(answerOf(r)).slice(0, 100), error: errorOf(r) };
    }
    const context = await ask('Reply with the word OK, then list word for word every rule, project instruction or memory about the person that you were given, or the word NONE.');
    results.context = { rule: says(context, 'PROJECT_RULE_MARK_H7'), rulesDir: says(context, 'RULES_DIR_MARK_R5'), memory: says(context, 'MEMORY_MARK_M6'), account: /@/.test(answerOf(context)), answer: clean(answerOf(context)).slice(0, 900) };
    const memory = await ask('What is my favourite word? If you do not know, reply with the single word UNKNOWN.');
    results.memoryAsked = { memory: says(memory, 'MEMORY_MARK_M6'), answer: clean(answerOf(memory)).slice(0, 80) };
    results.hookRan = fs.existsSync(hooked);
    results.mcpStarted = fs.existsSync(`${hooked}.mcp`);
    const cmd = await ask('Use the Bash tool to run: echo BASH_RAN_K9. If you have no such tool, reply with the single word NOTOOL.');
    results.bash = { ran: says(cmd, 'BASH_RAN_K9'), ...tried(cmd), answer: clean(answerOf(cmd)).slice(0, 40) };
    const web = await ask('Use a web tool to fetch https://example.com and report its title. If you have no such tool, reply with the single word NOTOOL.');
    results.web = { ...tried(web), answer: clean(answerOf(web)).slice(0, 40) };
    const write = await ask('Use a tool to create a file called written.txt here. If you have no such tool, reply with the single word NOTOOL.');
    results.write = { wrote: fs.existsSync(path.join(root, 'written.txt')), ...tried(write), answer: clean(answerOf(write)).slice(0, 40) };
    research.shutdown();
    fs.rmSync(memoryDir, { recursive: true, force: true });
    return results;
  },
  async 'research-codex'() {
    return { note: 'not run: the probe found the read-only sandbox does not hold a run to its folder' };
  },
  async 'context-codex'(rt) {
    // whether a project instruction file reaches a turn, for what autoContextControl would have to hold back
    fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Always end every reply with the word PROJECT_RULE_MARK_H7.\n');
    const r = await run(rt, { prompt: 'Reply with the single word OK, followed by any rule your project instructions tell you to follow.' });
    fs.rmSync(path.join(project, 'AGENTS.md'));
    return { ended: endOf(r), projectRuleReached: says(r, 'PROJECT_RULE_MARK_H7') };
  },
};

const PLAN = {
  codex: ['fresh', 'resume', 'fork', 'cancel', 'cancel-early', 'approvals', 'approval-twice', 'image', 'materials', 'busy', 'context-codex', 'research-codex'],
  claude: ['fresh', 'resume', 'fork', 'cancel', 'cancel-early', 'approvals', 'approval-twice', 'image', 'materials', 'busy', 'research-claude'],
};

(async () => {
  const runtime = start();
  const catalog = await runtime.models();
  if (name === 'codex') {
    // the smallest it offers: this is a check, not work
    const ids = catalog.models.map((m) => m.id);
    const pick = process.env.TD_ACCEPT_MODEL ?? ids.find((id) => /mini|spark|nano/i.test(id)) ?? (catalog.default ?? '').replace(/^codex\//, '') ?? ids[0];
    model = { provider: 'codex', id: pick };
  } else {
    model = { provider: 'claude-code', id: process.env.TD_ACCEPT_MODEL ?? 'haiku' };
  }
  const report = await runtime.capabilities();
  console.log(JSON.stringify({ runtime: name, version: report?.binaryVersion, model: model.id, models: catalog.models.map((m) => m.id), capabilities: report?.capabilities }));
  for (const scenario of only.length ? only : PLAN[name]) {
    const startedAt = Date.now();
    try {
      console.log(JSON.stringify({ scenario, ms: null, ...JSON.parse(clean(JSON.stringify(await scenarios[scenario](runtime)))), ms: Date.now() - startedAt }));
    } catch (e) {
      console.log(JSON.stringify({ scenario, threw: clean(e.message) }));
    }
  }
  runtime.shutdown();
  // the throwaway project: the sessions in the person's history stay theirs
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(0);
})();
