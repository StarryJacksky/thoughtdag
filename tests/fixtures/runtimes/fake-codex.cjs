#!/usr/bin/env node
// A stand-in for `codex app-server`: JSON-RPC 2.0 over stdio, newline
// delimited, speaking the methods runtime/agents/codex.cjs uses. It calls no
// model. It records what it was handed (every message, and every material
// file under the thread's working directory at the moment a turn starts)
// to the JSONL file named by TD_FAKE_CAPTURE, and answers with fixed text.
//
// TD_FAKE_SCRIPT may name a JSON file that changes its behavior:
//   { "reply": "...", "models": [...], "busyThreads": ["<thread id>"] }
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

record({ kind: 'argv', argv: process.argv.slice(2) });
if (process.argv[2] !== 'app-server') {
  process.stderr.write('fake codex: only `app-server` is implemented\n');
  process.exit(2);
}

const threads = new Map(); // thread id → { cwd, turnId }
const rolloutOf = (id) => path.join(SESSIONS, `rollout-${id}.jsonl`);

function handle(msg) {
  record({ kind: 'in', msg });
  const reply = (result) => out({ jsonrpc: '2.0', id: msg.id, result });
  const refuse = (message, code = -32000) => out({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
  const p = msg.params ?? {};
  switch (msg.method) {
    case 'initialize': return reply({ userAgent: 'fake-codex/0.0.0' });
    case 'initialized': return undefined;
    case 'model/list': return reply({ data: script.models ?? MODELS });
    case 'thread/start': {
      const id = randomUUID();
      threads.set(id, { cwd: p.cwd, turnId: null });
      return reply({ thread: { id, path: rolloutOf(id) } });
    }
    case 'thread/resume': {
      if ((script.busyThreads ?? []).includes(p.threadId)) return refuse('thread is busy in another client');
      threads.set(p.threadId, { cwd: p.cwd, turnId: null });
      return reply({ thread: { id: p.threadId, path: rolloutOf(p.threadId) } });
    }
    case 'thread/fork': {
      const id = randomUUID();
      threads.set(id, { cwd: p.cwd, turnId: null, forkedFrom: p.threadId });
      return reply({ thread: { id, path: rolloutOf(id) } });
    }
    case 'turn/start': {
      const thread = threads.get(p.threadId);
      if (!thread) return refuse(`unknown thread ${p.threadId}`);
      const turnId = randomUUID();
      thread.turnId = turnId;
      record({ kind: 'readable', threadId: p.threadId, cwd: thread.cwd, files: readableMaterials(thread.cwd) });
      fs.mkdirSync(SESSIONS, { recursive: true });
      fs.appendFileSync(rolloutOf(p.threadId), JSON.stringify({ type: 'turn_context', payload: { effort: p.effort ?? 'medium' } }) + '\n');
      reply({ turn: { id: turnId } });
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
      if (msg.id !== undefined) refuse(`unknown method ${msg.method}`, -32601);
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
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
