// A synthetic project folder on a real temp directory, with a workspace
// service over it: what the host tests of the workspace share. Nothing here
// touches a real project; every folder is made for the test and removed
// after it.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createWorkspaceService, entryIdOf } = require('../../../runtime/workspace/index.cjs');

const sha = (content) => 'sha256:' + createHash('sha256').update(content).digest('hex');
const errno = (code) => Object.assign(new Error(code), { code });

/**
 * `fixture(test, prefix)` makes a base directory that is removed when the
 * test file ends, and returns `setup(options)`: a fresh project with two
 * files, a fresh shell state directory, and a service that has the project
 * open. `options` reach the service; `start(more)` makes another service
 * over the same state, which is what a restart is.
 */
function fixture(test, prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tdag-${prefix}-`)));
  test.after(() => {
    for (const dir of fs.readdirSync(base)) { try { fs.chmodSync(path.join(base, dir), 0o755); } catch { /* not a directory */ } }
    fs.rmSync(base, { recursive: true, force: true });
  });
  let serial = 0;
  return async function setup(options = {}) {
    const id = ++serial;
    const project = path.join(base, `project-${id}`);
    const stateDir = path.join(base, `state-${id}`);
    for (const [rel, content] of Object.entries({ 'notes/a.md': 'FIRST_TEXT_B3\n', 'papers/keep.md': 'KEEP_TEXT_C4\n' })) {
      fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
      fs.writeFileSync(path.join(project, rel), content);
    }
    let pick = project;
    const start = (more = {}) => createWorkspaceService({ stateDir, pickDirectory: async () => pick, ...options, ...more });
    const service = start();
    const workspace = await service.chooseRoot();
    const at = (rel) => path.join(project, rel);
    const request = (key, more = {}) => ({ workspaceId: workspace.workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: key, ...more });
    const open = async (rel, s = service) => {
      const record = await s.registerEntry(workspace.workspaceId, entryIdOf(rel));
      return { record, ...(await s.readText(record.fileId)) };
    };
    /** Open another folder as a workspace through the same picker. */
    const choose = async (dir, s = service) => { pick = dir; try { return await s.chooseRoot(); } finally { pick = project; } };
    return { base, project, stateDir, service, workspace, start, at, request, open, choose, notes: entryIdOf('notes'), papers: entryIdOf('papers') };
  };
}

const journalOf = (project) => path.join(project, '.thoughtdag', 'journal.jsonl');
const registryOf = (project) => JSON.parse(fs.readFileSync(path.join(project, '.thoughtdag', 'resources.json'), 'utf8'));
const journalLine = (entry) => JSON.stringify({ at: '2026-10-04T00:00:00Z', ...entry }) + '\n';
/** Files in a folder that this application made for itself and should not have left behind. */
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tdag-'));

/**
 * File-system calls with a meeting point: every call of a named method
 * waits until `count` such calls have arrived, or until `ms` has passed,
 * and only then goes on. It makes two operations reach the same step
 * together when nothing stops them, and lets them through one at a time
 * when something does.
 */
function meetingAt(methods, { count = 2, ms = 150 } = {}) {
  let waiting = [];
  const arrive = () => new Promise((resolve) => {
    waiting.push(resolve);
    const release = () => { const all = waiting; waiting = []; for (const go of all) go(); };
    if (waiting.length >= count) release(); else setTimeout(release, ms);
  });
  const io = { ...fs.promises };
  for (const method of methods) io[method] = async (...args) => { await arrive(); return fs.promises[method](...args); };
  return io;
}

module.exports = { fixture, sha, errno, journalOf, registryOf, journalLine, leftovers, meetingAt, entryIdOf };
