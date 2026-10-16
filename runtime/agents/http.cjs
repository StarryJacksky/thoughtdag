// The agents surface over HTTP, for hosts that are not the desktop shell:
// the harness plugin's host and the local server. Same calls as
// window.desktopAgents, one endpoint each, and one server-sent-events feed
// carrying every run's events (the renderer's shim turns it back into
// onEvent). Runtimes are created on first use, as in the shell.
'use strict';
const path = require('node:path');
const os = require('node:os');
const ops = require('./ops.cjs');
const terminal = require('../terminal.cjs');

const RUNTIME_FACTORIES = {
  pi: (log) => require('./pi.cjs').createPiRuntime({ log }),
  codex: (log) => require('./codex.cjs').createCodexRuntime({ log }),
  'claude-code': (log) => require('./claude.cjs').createClaudeRuntime({ log }),
};

function createAgentsHttp({ workspaceRoot = path.join(os.homedir(), '.thoughtdag', 'workspaces'), log = () => {} } = {}) {
  const runtimes = new Map();
  const owners = new Map();      // runId → runtime name
  const clients = new Set();     // SSE responses
  const runtime = (name = 'pi') => {
    const key = RUNTIME_FACTORIES[name] ? name : 'pi';
    if (!runtimes.has(key)) runtimes.set(key, RUNTIME_FACTORIES[key](log));
    return runtimes.get(key);
  };
  const broadcast = (payload) => {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } }
  };
  const heartbeat = setInterval(() => { for (const res of clients) { try { res.write(': hb\n\n'); } catch { clients.delete(res); } } }, 20000);
  heartbeat.unref?.();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /**
   * Handle one request. `sub` is the path after the mount point, starting
   * with `/agents`; `body` is the parsed JSON body (or null). Returns false
   * when the path is not ours.
   */
  async function handle(req, res, sub, body) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = sub.replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    try {
      if (p === '/agents/available' && method === 'GET') {
        const out = {};
        for (const name of Object.keys(RUNTIME_FACTORIES)) out[name] = await runtime(name).available().catch(() => null);
        return json(res, 200, out), true;
      }
      if (p === '/agents/models' && method === 'GET') {
        try { return json(res, 200, await runtime(url.searchParams.get('runtime') ?? 'pi').models()), true; }
        catch (e) { return json(res, 200, { installed: false, models: [], default: null, error: e instanceof Error ? e.message : String(e) }), true; }
      }
      if (p === '/agents/events' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return true;
      }
      if (p === '/agents/run' && method === 'POST') {
        const r = body && typeof body === 'object' ? body : {};
        const name = RUNTIME_FACTORIES[r.runtime] ? r.runtime : 'pi';
        const runId = await runtime(name).run(r, broadcast);
        owners.set(runId, name);
        return json(res, 200, { runId }), true;
      }
      if (p === '/agents/abort' && method === 'POST') {
        const id = String(body?.runId ?? '');
        return json(res, 200, { ok: runtime(owners.get(id)).abort(id) }), true;
      }
      if (p === '/agents/answer' && method === 'POST') {
        const id = String(body?.runId ?? '');
        return json(res, 200, { ok: runtime(owners.get(id)).answer(id, String(body?.requestId ?? ''), body?.response) }), true;
      }
      if (p === '/agents/workspace' && method === 'POST') return json(res, 200, { dir: await ops.workspaceFor(workspaceRoot, String(body?.canvasId ?? 'default')) }), true;
      if (p === '/agents/guard' && method === 'POST') return json(res, 200, { ok: await ops.writeGuard(String(body?.cwd ?? ''), body?.config) }), true;
      // no workspace is open here: a run's inputs are what the canvas holds, checked against their hashes
      if (p === '/agents/materials' && method === 'POST') return json(res, 200, await ops.materializeRun(String(body?.cwd ?? ''), body?.envelope, body?.provided)), true;
      if (p === '/agents/open-in-cli' && method === 'POST') return json(res, 200, await terminal.openInTerminal(String(body?.runner ?? ''), body?.cwd ?? null, String(body?.sessionId ?? ''))), true;
      return false;
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
      return true;
    }
  }

  const shutdown = () => { clearInterval(heartbeat); for (const r of runtimes.values()) r.shutdown(); for (const res of clients) { try { res.end(); } catch { /* gone */ } } };
  return { handle, shutdown };
}

module.exports = { createAgentsHttp };
