#!/usr/bin/env node
// A stand-in for `pi --mode rpc`: one line of JSON per command, answered by id. It
// calls no model. A prompt stays under way until it is aborted, unless
// TD_FAKE_SCRIPT says `{ "answer": true }`. It records what it was handed to the
// JSONL file named by TD_FAKE_CAPTURE.
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const CAPTURE = process.env.TD_FAKE_CAPTURE;
const script = process.env.TD_FAKE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.TD_FAKE_SCRIPT, 'utf8')) : {};
const record = (entry) => { if (CAPTURE) fs.appendFileSync(CAPTURE, JSON.stringify({ runtime: 'pi', ...entry }) + '\n'); };
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
let sessionId = randomUUID();
let prompting = null;

if (process.argv.includes('--version') || process.argv.includes('--help')) { process.stdout.write('pi 0.0.0-synthetic\n'); process.exit(0); }

function handle(cmd) {
  record({ kind: 'in', msg: cmd });
  const reply = (data) => out({ type: 'response', id: cmd.id, success: true, data });
  switch (cmd.type) {
    case 'new_session': sessionId = randomUUID(); return reply({});
    case 'get_state': return reply({ sessionId, sessionFile: `/synthetic/pi/${sessionId}.jsonl`, thinkingLevel: null });
    case 'prompt':
      prompting = cmd.id;
      if (script.answer) {
        setImmediate(() => {
          out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic pi answer' }] } });
          out({ type: 'agent_end' });
          reply({});
          prompting = null;
        });
      }
      return undefined;
    case 'abort':
      reply({});
      if (prompting) { out({ type: 'agent_end' }); out({ type: 'response', id: prompting, success: true, data: {} }); prompting = null; }
      return undefined;
    default: return reply({});
  }
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { handle(JSON.parse(line)); } catch { /* not a command */ }
  }
});
process.stdin.on('end', () => process.exit(0));
