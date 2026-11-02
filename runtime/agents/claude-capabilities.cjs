// What an installed Claude Code can do, as found out from the binary itself. What
// it offers is read from its `--help`. What a run limited to reading tools comes up
// with is tried: `--bare` reads no login and no keychain, the process runs in a home
// of its own in a temp folder, and with no credentials it stops at its first request,
// so the person's login, settings and sessions are not touched and no model is reached.
// What could not be read or tried is unknown, never supported.
'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fsp = fs.promises;
const STEP_MS = 30 * 1000;
const NAMES = ['fresh', 'resume', 'forkAtCompletedTurn', 'observeState', 'cancel', 'approvals', 'readOnlyRoots', 'networkRestriction', 'autoContextControl'];
/** What a run limited to reading may use. */
const READING_TOOLS = ['Read', 'Glob', 'Grep'];
const CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

// What a process started from inside a Claude Code session has of that session: its id, its way of
// talking to its host, its mode (`CLAUDE_CODE_SIMPLE` is `--bare`, which reads no login), its host's proxy.
// A run is its own. How the person signs in, and where their config is, stay.
const STAYS = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']);
function withoutHostSession(env) {
  if (!env.CLAUDECODE) return env;
  const own = { ...env };
  for (const name of Object.keys(own)) if ((/^CLAUDE/.test(name) && !STAYS.has(name)) || name === 'ANTHROPIC_BASE_URL') delete own[name];
  return own;
}

const allUnknown = () => Object.fromEntries(NAMES.map((n) => [n, 'unknown']));
const say = (binary, args, env) => new Promise((resolve) => {
  execFile(binary, args, { env, timeout: STEP_MS, maxBuffer: 1 << 20 }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

/** The version the binary says it is, or null if it cannot be run. */
async function versionOf(binaryPath, env = process.env) {
  const said = (await say(binaryPath, ['--version'], env)).trim();
  return said.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? (said || null);
}

/** The `--help` of this version, or '' if it gives none. */
const helpOf = (binaryPath, env = process.env) => say(binaryPath, ['--help'], env);
/** The flags a help text names. */
const flagsIn = (help) => new Set(help.match(/--[a-z][a-z-]*/g) ?? []);

/** The tools a process limited to reading comes up with, as it says when it starts; null when it says nothing. */
function toolsItComesUpWith(binaryPath, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ['--bare', '--restricted', '--tools', READING_TOOLS.join(','), '--strict-mcp-config', '--permission-mode', 'dontAsk', '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let answer = null;
    const timer = setTimeout(() => child.kill(), STEP_MS);
    const finish = () => { clearTimeout(timer); resolve(answer); };
    child.on('error', finish);
    child.on('exit', finish);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.tools)) { answer = msg.tools; child.kill(); return; }
      }
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'probe' }] } }) + '\n');
  });
}

/**
 * The CapabilityReport of the Claude Code at `binaryPath`.
 *   forkAtCompletedTurn: `--fork-session` copies the whole history; there is no boundary to name.
 *   observeState: whether another client is at work in a session cannot be asked; it shows when it refuses.
 *   readOnlyRoots, autoContextControl: the help promises them (`--restricted`, `--safe-mode`), and whether
 *   they hold shows only in a turn, which reaches a model.
 */
async function probeClaude(binaryPath, { now = () => new Date().toISOString() } = {}) {
  const capabilities = allUnknown();
  const report = { runtime: 'claude-code', binaryVersion: null, probedAt: now(), capabilities };
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tdag-claude-probe-'));
  try {
    const home = path.join(root, 'home');
    await fsp.mkdir(home);
    const env = { ...withoutHostSession(process.env), HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
    for (const name of CREDENTIALS) delete env[name];
    report.binaryVersion = await versionOf(binaryPath, env);
    if (!report.binaryVersion) return report;
    const help = await helpOf(binaryPath, env);
    if (!help) return report;
    const flags = flagsIn(help);
    capabilities.fresh = ['--print', '--output-format', '--input-format'].every((f) => flags.has(f)) ? 'supported' : 'unsupported';
    capabilities.resume = flags.has('--resume') ? 'supported' : 'unsupported';
    capabilities.forkAtCompletedTurn = 'unsupported';
    capabilities.observeState = 'unsupported';
    capabilities.cancel = 'supported'; // the process is this application's own to stop
    capabilities.approvals = flags.has('--permission-prompt-tool') ? 'supported' : 'unsupported';
    if (['--bare', '--restricted', '--tools'].every((f) => flags.has(f))) {
      const tools = await toolsItComesUpWith(binaryPath, env, home).catch(() => null);
      if (tools) capabilities.networkRestriction = tools.every((t) => READING_TOOLS.includes(t)) ? 'supported' : 'unsupported';
    }
    return report;
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { probeClaude, versionOf, helpOf, flagsIn, withoutHostSession, READING_TOOLS };
