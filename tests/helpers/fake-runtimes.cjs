// Puts the fake `codex` and `claude` (tests/fixtures/runtimes) where the
// host's lookup finds them, in a throwaway home of their own. Call it BEFORE
// requiring anything under runtime/agents: those modules read HOME and cache
// the binary they locate.
//
// Nothing of the real machine is read: HOME points at a temp directory (so no
// real ~/.codex or ~/.claude), PATH holds the fake bin plus the system
// directories, and the login-shell PATH lookup is given no shell to ask.
// POSIX only for now: the launchers are sh scripts.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKES = path.join(__dirname, '..', 'fixtures', 'runtimes');

function installFakeRuntimes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-fake-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const sessions = path.join(root, 'sessions');
  const project = path.join(root, 'project');
  for (const d of [bin, home, sessions, project]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['codex', 'claude']) {
    const launcher = path.join(bin, name);
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FAKES, `fake-${name}.cjs`)}" "$@"\n`);
    fs.chmodSync(launcher, 0o755);
  }
  const capture = path.join(root, 'capture.jsonl');
  const scriptFile = path.join(root, 'script.json');

  const saved = {};
  const setEnv = (key, value) => { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  setEnv('PATH', [bin, '/usr/bin', '/bin'].join(path.delimiter));
  setEnv('HOME', home);
  setEnv('SHELL', path.join(root, 'no-login-shell'));
  setEnv('CODEX_HOME', path.join(home, '.codex'));
  setEnv('TD_FAKE_CAPTURE', capture);
  setEnv('TD_FAKE_SESSIONS', sessions);
  setEnv('TD_FAKE_SCRIPT', undefined);

  return {
    root, bin, home, sessions, project, capture,
    /** every record the fakes wrote, oldest first; `runtime` filters to one of them */
    read(runtime) {
      if (!fs.existsSync(capture)) return [];
      const all = fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      return runtime ? all.filter((r) => r.runtime === runtime) : all;
    },
    /** forget what was recorded so far */
    clear() { fs.rmSync(capture, { force: true }); },
    /** change the fakes' behavior for processes started from now on; null restores the default */
    script(behavior) {
      if (behavior === null) { delete process.env.TD_FAKE_SCRIPT; return; }
      fs.writeFileSync(scriptFile, JSON.stringify(behavior));
      process.env.TD_FAKE_SCRIPT = scriptFile;
    },
    /** a material file as the canvas writes it for agents to read */
    writeMaterial(name, content) {
      const dir = path.join(project, '.thoughtdag', 'materials');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), content);
    },
    cleanup() {
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run one turn and resolve with every event it emitted, run_end last. */
function runToEnd(runtime, request, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error('the run did not end; events so far: ' + events.map((e) => e.type).join(', '))), timeoutMs);
    runtime.run(request, ({ event }) => {
      events.push(event);
      if (event.type === 'run_end') { clearTimeout(timer); resolve(events); }
    }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

module.exports = { installFakeRuntimes, runToEnd };
