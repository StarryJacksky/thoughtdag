// What every host does around a run, in plain Node: the per-canvas
// workspace directory, a run's inputs written where its agent can read
// them, the boundary guard's tuning file. Used by the desktop shell,
// the harness plugin host and the local server alike.
'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');
const { materialize, pruneRuns, MaterializeError } = require('../execution/materialize.cjs');
const { verifyPolicy } = require('../execution/policy.cjs');

const WORKSPACE_ID = /^[\w.-]{1,80}$/;
const RUN_ID = /^run_[A-Za-z0-9_-]{1,80}$/;
const fileExists = (p) => fsp.access(p).then(() => true, () => false);

/** The shell-managed working directory of a canvas, created on demand. */
async function workspaceFor(root, canvasId) {
  if (!WORKSPACE_ID.test(String(canvasId))) throw new Error('bad canvas id');
  const dir = path.join(root, String(canvasId));
  await fsp.mkdir(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!(await fileExists(readme))) {
    await fsp.writeFile(readme, `# ThoughtDAG workspace\n\nThis folder is the working directory of one ThoughtDAG canvas (id ${canvasId}).\nAgents launched from that canvas read, write and run commands here unless the\ncanvas mirrors a session that already has a working directory of its own.\n`);
  }
  return dir;
}

/**
 * A run's inputs, written for its agent from the run's envelope, under
 * <cwd>/.thoughtdag/runs/<runId>/materials (runtime/execution/materialize.cjs).
 * The policy is checked first: a run the runtime cannot be held to is not
 * given anything. `readers` read the workspace's frozen files; `provided`
 * holds what the canvas holds, by input id. Answers `{ ok, dir, receipt }`
 * (`dir` relative to `cwd`), or `{ ok: false, code, message, inputId }`.
 * The oldest run directories beyond the newest 20 are removed, each only if
 * it holds exactly what its manifest lists.
 */
async function materializeRun(cwd, envelope, provided, readers = {}) {
  const refused = (code, message, more = {}) => ({ ok: false, code, message, inputId: null, ...more });
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return refused('invalid-request', 'the working directory must be an absolute path');
  if (!envelope || typeof envelope !== 'object' || !RUN_ID.test(String(envelope.runId))) return refused('invalid-envelope', 'that is not a run envelope');
  // what is known of the runtimes' capabilities: nothing yet (T15, T16), so research by an agent is refused
  const verdict = verifyPolicy(envelope, null);
  if (!verdict.ok) return refused('policy', 'the run cannot be held to its policy here: ' + verdict.blocked.join(', '), { blocked: verdict.blocked });
  const runs = path.join(cwd, '.thoughtdag', 'runs');
  const dir = path.join(runs, String(envelope.runId));
  try {
    const receipt = await materialize(envelope, dir, { ...readers, provided: provided && typeof provided === 'object' ? provided : {} });
    await pruneRuns(runs, { keep: 20 }).catch(() => undefined);
    return { ok: true, dir: path.relative(cwd, dir).split(path.sep).join('/'), receipt };
  } catch (e) {
    if (e instanceof MaterializeError) return refused(e.code, e.message, { inputId: e.inputId });
    return refused('unavailable', e instanceof Error ? e.message : String(e));
  }
}

/** The guard's tuning for a working directory: <cwd>/.thoughtdag/guard.json */
async function writeGuard(cwd, config) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const dir = path.join(cwd, '.thoughtdag');
  await fsp.mkdir(dir, { recursive: true });
  const mode = config?.mode === 'allow' || config?.mode === 'auto' ? config.mode : 'ask';
  const allow = Array.isArray(config?.allow) ? config.allow.filter((x) => typeof x === 'string' && path.isAbsolute(x)).slice(0, 100) : [];
  await fsp.writeFile(path.join(dir, 'guard.json'), JSON.stringify({ mode, allow }, null, 2));
  return true;
}

module.exports = { workspaceFor, materializeRun, writeGuard };
