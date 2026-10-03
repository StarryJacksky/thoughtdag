#!/usr/bin/env node
// A stand-in for `claude -p` in stream-json both ways, speaking the lines
// runtime/agents/claude.cjs reads. It calls no model. It records what it was
// handed (its arguments, every stdin message, and every material file under
// its working directory when the turn starts) to the JSONL file named by
// TD_FAKE_CAPTURE, answers with fixed text, and exits.
//
// TD_FAKE_SCRIPT may name a JSON file that changes its behavior:
//   { "reply": "..." }
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { readableMaterials } = require('./readable.cjs');

const HELP = `Usage: claude [options] [prompt]

Options:
  --effort <level>  Effort level for the session (low, medium, high)
  --model <model>   Model for the session
`;

const argv = process.argv.slice(2);
if (argv.includes('--help')) { process.stdout.write(HELP); process.exit(0); }

const CAPTURE = process.env.TD_FAKE_CAPTURE;
const script = process.env.TD_FAKE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.TD_FAKE_SCRIPT, 'utf8')) : {};
const record = (entry) => { if (CAPTURE) fs.appendFileSync(CAPTURE, JSON.stringify({ runtime: 'claude', ...entry }) + '\n'); };
const out = (obj, done) => process.stdout.write(JSON.stringify(obj) + '\n', done);

record({ kind: 'argv', argv, cwd: process.cwd() });

// --resume continues that session; with --fork-session it branches into a new one
const resumeAt = argv.indexOf('--resume');
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : null;
const sessionId = resumed && !argv.includes('--fork-session') ? resumed : randomUUID();

let answered = false;
function handle(msg) {
  record({ kind: 'in', msg });
  if (msg.type !== 'user' || answered) return;
  answered = true;
  record({ kind: 'readable', sessionId, cwd: process.cwd(), files: readableMaterials(process.cwd()) });
  const text = script.reply ?? 'synthetic claude answer';
  out({ type: 'system', subtype: 'init', session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'assistant', message: { model: 'claude-synthetic-1', content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', result: text }, () => process.exit(0));
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
