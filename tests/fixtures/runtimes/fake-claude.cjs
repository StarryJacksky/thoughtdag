#!/usr/bin/env node
// A stand-in for `claude -p` in stream-json both ways, speaking the lines
// runtime/agents/claude.cjs reads. It calls no model. It records what it was
// handed (its arguments, every stdin message, and every material file under
// its working directory when the turn starts) to the JSONL file named by
// TD_FAKE_CAPTURE, answers with fixed text, and exits.
//
// TD_FAKE_SCRIPT may name a JSON file that changes its behavior:
//   { "reply": "...", "version": "...", "help": "...", "without": ["--flag"],
//     "failure": "...", "missing": true, "busy": true, "hold": true, "tools": [...], "noHelp": true }
// What it does when refused, and how a turn that failed ends, is what the real
// CLI was seen to do. See docs/research-workspace/compatibility.md.
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { readableMaterials } = require('./readable.cjs');

const FLAGS = ['--print', '--output-format', '--input-format', '--verbose', '--include-partial-messages', '--permission-mode', '--permission-prompts', '--resume', '--fork-session', '--tools', '--restricted', '--safe-mode', '--strict-mcp-config', '--bare'];
const HELP = (without = []) => `Usage: claude [options] [prompt]

Options:
${FLAGS.filter((f) => !without.includes(f)).map((f) => `  ${f}  something${f === '--permission-prompts' ? ' (the host, or --permission-prompt-tool)' : ''}`).join('\n')}
  ${without.includes('--effort') ? '' : '--effort <level>  Effort level for the session (low, medium, high)'}
  ${without.includes('--model') ? '' : '--model <model>   Model for the session'}
`;

const argv = process.argv.slice(2);
const CAPTURE = process.env.TD_FAKE_CAPTURE;
const script = process.env.TD_FAKE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.TD_FAKE_SCRIPT, 'utf8')) : {};
if (argv.includes('--version')) { process.stdout.write(`${script.version ?? '9.9.9-synthetic'} (Claude Code)\n`); process.exit(0); }
if (argv.includes('--help')) {
  if (script.noHelp) process.exit(1);
  process.stdout.write(script.help ?? HELP(script.without));
  process.exit(0);
}
const record = (entry) => { if (CAPTURE) fs.appendFileSync(CAPTURE, JSON.stringify({ runtime: 'claude', ...entry }) + '\n'); };
const out = (obj, done) => process.stdout.write(JSON.stringify(obj) + '\n', done);

record({ kind: 'argv', argv, cwd: process.cwd(), home: process.env.HOME });
const unknown = (script.without ?? []).find((f) => argv.includes(f));
if (unknown) { process.stderr.write(`error: unknown option '${unknown}'\n`); process.exit(1); }

// --resume continues that session; with --fork-session it branches into a new one
const resumeAt = argv.indexOf('--resume');
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : null;
const sessionId = resumed && !argv.includes('--fork-session') ? resumed : randomUUID();
const toolsAt = argv.indexOf('--tools');
const tools = script.tools ?? (toolsAt >= 0 ? argv[toolsAt + 1].split(',').filter(Boolean) : ['Bash', 'Edit', 'Read', 'WebFetch']);

let answered = false;
function handle(msg) {
  record({ kind: 'in', msg });
  if (msg.type !== 'user' || answered) return;
  answered = true;
  record({ kind: 'readable', sessionId, cwd: process.cwd(), files: readableMaterials(process.cwd()) });
  if (resumed && script.missing) {
    process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: resumed }, () => process.exit(1));
    return;
  }
  if (resumed && script.busy) {
    process.stderr.write(`Error: Session ID ${resumed} is already in use.\n`);
    process.exit(1);
  }
  const text = script.failure ?? script.reply ?? 'synthetic claude answer';
  out({ type: 'system', subtype: 'init', session_id: sessionId, tools, permissionMode: 'default' });
  if (script.hold) return; // nothing more until it is stopped
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'assistant', uuid: 'assistant-entry-1', message: { model: 'claude-synthetic-1', content: [{ type: 'text', text }] } });
  // a turn that failed still says "success": the real CLI marks it with is_error, and exits 1
  if (script.failure) { out({ type: 'result', subtype: 'success', is_error: true, result: text }, () => process.exit(1)); return; }
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
