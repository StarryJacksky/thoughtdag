#!/usr/bin/env node
// A stand-in for `codex app-server`: JSON-RPC 2.0 over stdio, newline
// delimited, speaking the methods runtime/agents/codex.cjs uses. It calls no
// model. It records what it was handed (every message, and every material
// file under the thread's working directory at the moment a turn starts)
// to the JSONL file named by TD_FAKE_CAPTURE, and answers with fixed text.
//
// TD_FAKE_SCRIPT may name a JSON file that changes its behavior:
//   { "reply": "...", "models": [...], "busyThreads": ["<thread id>"],
//     "activeThreads": ["<thread id>"], "turns": { "<thread id>": [{ "id", "status" }] },
//     "without": ["<method>"], "noLastTurnId": true, "noSchema": true,
//     "delay": { "<method>": ms }, "hold": true, "heldByAnother": ["<thread id>"],
//     "sandbox": { "read": "open"|"closed", "network": "open"|"closed" } }
// What it refuses, and how, is what the real server was seen to do: a request
// before the handshake, an unknown method, a fork at a turn in progress or at
// no turn. See docs/research-workspace/compatibility.md.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readableMaterials } = require('./readable.cjs');

const CAPTURE = process.env.TD_FAKE_CAPTURE;
const SESSIONS = process.env.TD_FAKE_SESSIONS || path.join(os.tmpdir(), 'tdag-fake-sessions');
const script = process.env.TD_FAKE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.TD_FAKE_SCRIPT, 'utf8')) : {};
const record = (entry) => { if (CAPTURE) fs.appendFileSync(CAPTURE, JSON.stringify({ runtime: 'codex', ...entry }) + '\n'); };
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const MODELS = [
  { id: 'gpt-synthetic', model: 'gpt-synthetic', displayName: 'Synthetic', isDefault: true, supportedReasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
];

record({ kind: 'argv', argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME ?? null });
if (process.argv[2] === '--version') {
  process.stdout.write(`codex-cli ${script.version ?? '9.9.9-synthetic'}\n`);
  process.exit(0);
}
if (process.argv[2] === 'app-server' && process.argv[3] === 'generate-json-schema') {
  if (script.noSchema) { process.stderr.write('error: unrecognized subcommand\n'); process.exit(2); }
  const out = process.argv[process.argv.indexOf('--out') + 1];
  const without = script.without ?? [];
  const methods = ['initialize', 'model/list', 'thread/start', 'thread/resume', 'thread/fork', 'thread/read', 'thread/turns/list', 'turn/start', 'turn/interrupt', 'command/exec'].filter((m) => !without.includes(m));
  const union = (names) => ({ oneOf: names.map((name) => ({ properties: { method: { enum: [name] } } })) });
  fs.mkdirSync(path.join(out, 'v2'), { recursive: true });
  fs.writeFileSync(path.join(out, 'ClientRequest.json'), JSON.stringify(union(methods)));
  fs.writeFileSync(path.join(out, 'ServerRequest.json'), JSON.stringify(union(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].filter((m) => !without.includes(m)))));
  fs.writeFileSync(path.join(out, 'v2', 'ThreadForkParams.json'), JSON.stringify({ properties: { threadId: {}, ...(script.noLastTurnId ? {} : { lastTurnId: {} }) } }));
  process.exit(0);
}
if (process.argv[2] !== 'app-server') {
  process.stderr.write('fake codex: only `app-server` is implemented\n');
  process.exit(2);
}

const threads = new Map(); // thread id → { cwd, turnId }
let shookHands = false;
let asked = 0;
const turnsOf = (id) => [...(script.turns?.[id] ?? []), ...(threads.get(id)?.turns ?? [])];
// a thread's own id, and the id of the session tree it belongs to: not the same thing
const threadOf = (id) => ({ id, sessionId: `tree-of-${id}`, path: rolloutOf(id), status: { type: (script.activeThreads ?? []).includes(id) ? 'active' : 'idle' } });
const rolloutOf = (id) => path.join(SESSIONS, `rollout-${id}.jsonl`);

async function handle(msg) {
  record({ kind: 'in', msg });
  if (msg.method === undefined) return undefined; // an answer to one of its own requests
  const wait = script.delay?.[msg.method];
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result });
  const refuse = (message, code = -32000) => out({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
  const p = msg.params ?? {};
  if (msg.method === 'initialized') { shookHands = true; return undefined; }
  if (msg.method !== 'initialize' && !shookHands) return refuse('Not initialized', -32600);
  if ((script.without ?? []).includes(msg.method)) return refuse(`Invalid request: unknown variant \`${msg.method}\``, -32600);
  switch (msg.method) {
    case 'initialize': return reply({ userAgent: 'fake-codex/0.0.0' });
    case 'model/list': return reply({ data: script.models ?? MODELS });
    case 'thread/start': {
      const id = randomUUID();
      threads.set(id, { cwd: p.cwd, turnId: null });
      return reply({ thread: threadOf(id) });
    }
    case 'thread/read': return reply({ thread: threadOf(p.threadId) });
    case 'thread/turns/list': {
      const all = turnsOf(p.threadId);
      const from = Number(p.cursor ?? 0);
      const size = p.limit ?? all.length;
      const next = from + size < all.length ? String(from + size) : null;
      return reply({ data: all.slice(from, from + size), nextCursor: next });
    }
    case 'command/exec': {
      const [tool, ...rest] = p.command;
      if (path.basename(tool) === 'cat') {
        if (script.sandbox?.read !== 'open' && !rest[0].startsWith(p.cwd + path.sep)) return reply({ exitCode: 1, stdout: '', stderr: 'Operation not permitted' });
        return reply({ exitCode: 0, stdout: fs.readFileSync(rest[0], 'utf8'), stderr: '' });
      }
      if (path.basename(tool) === 'curl') {
        if (script.sandbox?.network !== 'open') return reply({ exitCode: 7, stdout: '', stderr: 'could not connect' });
        return require('node:http').get(rest[rest.length - 1], (r) => { r.resume(); r.on('end', () => reply({ exitCode: 0, stdout: 'ok', stderr: '' })); }).on('error', () => reply({ exitCode: 7, stdout: '', stderr: 'no' }));
      }
      return reply({ exitCode: 127, stdout: '', stderr: 'no such tool' });
    }
    case 'thread/resume': {
      if ((script.busyThreads ?? []).includes(p.threadId)) return refuse('thread is busy in another client');
      if ((script.heldByAnother ?? []).includes(p.threadId)) return refuse(`thread ${p.threadId} already has an active writer`, -32600);
      threads.set(p.threadId, { cwd: p.cwd, turnId: null });
      return reply({ thread: threadOf(p.threadId) });
    }
    case 'thread/fork': {
      if (p.lastTurnId) {
        const at = turnsOf(p.threadId).find((t) => t.id === p.lastTurnId);
        if (!at) return refuse(`turn not found: ${p.lastTurnId}`, -32600);
        if (at.status === 'inProgress') return refuse(`lastTurnId '${p.lastTurnId}' identifies an in-progress turn`, -32600);
      }
      const id = randomUUID();
      threads.set(id, { cwd: p.cwd, turnId: null, forkedFrom: p.threadId });
      return reply({ thread: threadOf(id) });
    }
    case 'turn/start': {
      const thread = threads.get(p.threadId);
      if (!thread) return refuse(`unknown thread ${p.threadId}`);
      const turnId = randomUUID();
      thread.turnId = turnId;
      record({ kind: 'readable', threadId: p.threadId, cwd: thread.cwd, files: readableMaterials(thread.cwd) });
      fs.mkdirSync(SESSIONS, { recursive: true });
      fs.appendFileSync(rolloutOf(p.threadId), JSON.stringify({ type: 'turn_context', payload: { effort: p.effort ?? 'medium' } }) + '\n');
      reply({ turn: { id: turnId, status: 'inProgress' } });
      // the server's own requests, each with an id of its own: { approvals: ["<command>", ...] }
      for (const command of script.approvals ?? []) {
        asked += 1;
        out({ jsonrpc: '2.0', id: 1000 + asked, method: 'item/commandExecution/requestApproval', params: { threadId: p.threadId, turnId, itemId: `item-${asked}`, command, reason: 'synthetic' } });
      }
      if (script.hold) return undefined; // nothing more until it is interrupted
      const text = script.reply ?? 'synthetic codex answer';
      setImmediate(() => {
        notify('item/agentMessage/delta', { threadId: p.threadId, delta: text });
        notify('item/completed', { threadId: p.threadId, item: { id: randomUUID(), type: 'agentMessage', text } });
        notify('turn/completed', { threadId: p.threadId, turn: { id: turnId, status: 'completed' } });
      });
      return undefined;
    }
    case 'turn/interrupt': {
      reply({});
      return notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted' } });
    }
    default:
      if (msg.id !== undefined) refuse(`Invalid request: unknown variant \`${msg.method}\``, -32600);
      return undefined;
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    void handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
