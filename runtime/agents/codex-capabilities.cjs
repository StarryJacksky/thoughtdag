// What an installed Codex can do, as found out from the binary itself. What it
// offers is read from the protocol schema it prints; what its sandbox holds to
// is tried, with commands that reach no model: reading a file outside the
// working directory, and connecting to a listener of this process. Every process
// runs with a home of its own in a temp folder, so the person's login, config,
// memory and threads are not touched, and no thread or turn is started. What
// could not be tried or read is unknown, never supported.
'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const fsp = fs.promises;
const STEP_MS = 15 * 1000;
const NAMES = ['fresh', 'resume', 'forkAtCompletedTurn', 'observeState', 'cancel', 'approvals', 'readOnlyRoots', 'networkRestriction', 'autoContextControl'];
const CURL = ['/usr/bin/curl', '/bin/curl'].find((p) => fs.existsSync(p)) ?? 'curl';

const allUnknown = () => Object.fromEntries(NAMES.map((n) => [n, 'unknown']));

const run = (binary, args, env) => new Promise((resolve, reject) => {
  execFile(binary, args, { env, timeout: STEP_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

/** The version the binary says it is, or null if it cannot be run. */
async function versionOf(binaryPath, env = process.env) {
  try {
    const said = (await run(binaryPath, ['--version'], env)).trim();
    return said.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? (said || null);
  } catch { return null; }
}

const methodsIn = async (file) => new Set((JSON.parse(await fsp.readFile(file, 'utf8')).oneOf ?? []).flatMap((m) => m?.properties?.method?.enum ?? []));
const has = (set, ...names) => (names.every((n) => set.has(n)) ? 'supported' : 'unsupported');

/** What the protocol schema offers; null when this version prints none. */
async function offered(binaryPath, env, dir) {
  try {
    await run(binaryPath, ['app-server', 'generate-json-schema', '--out', dir], env);
    const client = await methodsIn(path.join(dir, 'ClientRequest.json'));
    const server = await methodsIn(path.join(dir, 'ServerRequest.json'));
    const fork = JSON.parse(await fsp.readFile(path.join(dir, 'v2', 'ThreadForkParams.json'), 'utf8'));
    return {
      client,
      capabilities: {
        fresh: has(client, 'thread/start', 'turn/start'),
        resume: has(client, 'thread/resume'),
        // a fork without a boundary copies the whole history, and is no fork at a turn; the turn's state must be readable too
        forkAtCompletedTurn: client.has('thread/fork') && client.has('thread/turns/list') && fork.properties?.lastTurnId ? 'supported' : 'unsupported',
        observeState: has(client, 'thread/read'),
        cancel: has(client, 'turn/interrupt'),
        approvals: server.has('item/commandExecution/requestApproval') && server.has('item/fileChange/requestApproval') ? 'supported' : 'unsupported',
      },
    };
  } catch { return null; }
}

/** A short talk with `app-server`: the handshake, then `ask(send)`. */
async function talk(binaryPath, env, ask) {
  const proc = spawn(binaryPath, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let buf = '';
  let next = 1;
  const gone = new Promise((_, reject) => { proc.on('error', reject); proc.on('exit', () => reject(new Error('the server went away'))); });
  gone.catch(() => {});
  proc.stdin.on('error', () => {});
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const msg = JSON.parse(line); if (msg.id !== undefined && msg.method === undefined) waiting.get(msg.id)?.(msg); } catch { /* not a message */ }
    }
  });
  const send = (method, params) => {
    const id = next++;
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), STEP_MS);
      waiting.set(id, (msg) => { clearTimeout(timer); waiting.delete(id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); });
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return Promise.race([answer, gone]);
  };
  try {
    await send('initialize', { clientInfo: { name: 'thoughtdag-probe', title: 'ThoughtDAG', version: '0.5.0' }, capabilities: null });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
    return await ask(send);
  } finally {
    proc.kill();
  }
}

const SEALED = { type: 'readOnly', networkAccess: false };

/** Whether the read-only sandbox keeps a run to its working directory. Reading inside must work, or the attempt outside says nothing. */
async function triedReading(send, work, outside) {
  const cat = (file) => send('command/exec', { command: ['/bin/cat', file], cwd: work, sandboxPolicy: SEALED, timeoutMs: 8000 });
  const inside = await cat(path.join(work, 'inside.txt'));
  if (inside.exitCode !== 0) return 'unknown';
  return (await cat(outside)).exitCode === 0 ? 'unsupported' : 'supported';
}

/** Whether the sandbox keeps a run off the network, tried on a listener of this process: nothing leaves the machine. */
async function triedConnecting(send, work) {
  let reached = false;
  const server = http.createServer((_, res) => { reached = true; res.end('ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const tried = await send('command/exec', { command: [CURL, '-sS', '-m', '3', url], cwd: work, sandboxPolicy: SEALED, timeoutMs: 8000 });
    if (reached || tried.exitCode === 0) return 'unsupported';
    return tried.exitCode === 127 ? 'unknown' : 'supported';
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

/**
 * The CapabilityReport of the Codex at `binaryPath`. `autoContextControl` stays
 * unknown: whether the project's instruction files, skills and memory can be
 * kept out of a turn shows only in a turn, which reaches a model.
 */
async function probeCodex(binaryPath, { now = () => new Date().toISOString() } = {}) {
  const capabilities = allUnknown();
  const report = { runtime: 'codex', binaryVersion: null, probedAt: now(), capabilities };
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tdag-codex-probe-'));
  try {
    const home = path.join(root, 'home');
    const work = path.join(root, 'work');
    const outside = path.join(root, 'outside.txt');
    await fsp.mkdir(home);
    await fsp.mkdir(work);
    await fsp.writeFile(path.join(work, 'inside.txt'), 'inside\n');
    await fsp.writeFile(outside, 'outside\n');
    const env = { ...process.env, CODEX_HOME: home };
    report.binaryVersion = await versionOf(binaryPath, env);
    if (!report.binaryVersion) return report;
    const schema = await offered(binaryPath, env, path.join(root, 'schema'));
    if (schema) Object.assign(capabilities, schema.capabilities);
    if (schema && !schema.client.has('command/exec')) return report;
    await talk(binaryPath, env, async (send) => {
      capabilities.readOnlyRoots = await triedReading(send, work, outside).catch(() => 'unknown');
      capabilities.networkRestriction = await triedConnecting(send, work).catch(() => 'unknown');
    }).catch(() => {});
    return report;
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { probeCodex, versionOf };
