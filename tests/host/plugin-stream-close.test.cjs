// A caller that leaves stops the answer it asked for (L04). The plugin as shipped, on a
// stand-in host with a stand-in model that says what it was asked for: on Node 22 a
// request whose body has been read has already closed, so leaving shows on the response.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function standIn({ streamed, upstreamUrl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-l04-plugin-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.copyFileSync(path.join(ROOT, 'dsh', 'lib', 'index.js'), path.join(dir, 'lib', 'index.js'));
  fs.cpSync(path.join(ROOT, 'runtime'), path.join(dir, 'lib', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-thoughtdag', version: '0.0.0-test', type: 'module' }));
  let api = null;
  const ctx = {
    effect: (fn) => fn(),
    inject: () => {},
    on: () => () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    webServer: { register: ({ path: at, handler }) => { if (at.endsWith('/api')) api = handler; return () => {}; } },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    approval: { setPolicy: () => {} },
    sessionController: { modelCatalog: async () => ({ groups: [{ id: 'synthetic', name: 'synthetic', models: [{ id: 'model' }] }], default: { provider: 'synthetic', model: 'model' }, routableProviders: ['synthetic'] }), resolveAgent: async () => ({ error: {} }) },
    llm: {
      async *stream() {
        for (let i = 0; i < 200; i++) { streamed.count += 1; yield { type: 'text-delta', text: `chunk-${i} ` }; await pause(10); }
        yield { type: 'finish' };
      },
    },
  };
  void upstreamUrl;
  const plugin = await import(pathToFileURL(path.join(dir, 'lib', 'index.js')).href);
  await plugin.apply(ctx, { whyTools: false, whyPrompt: false });
  const server = http.createServer((req, res) => api(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { dir, server, port: server.address().port };
}

test('[L04] a caller that leaves a harness model\'s stream stops it', async (t) => {
  const streamed = { count: 0 };
  const plugin = await standIn({ streamed });
  t.after(() => { plugin.server.closeAllConnections(); plugin.server.close(); fs.rmSync(plugin.dir, { recursive: true, force: true }); });
  const leave = new AbortController();
  const asked = await fetch(`http://127.0.0.1:${plugin.port}/thoughtdag/api/stream`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'synthetic/model', messages: [{ role: 'user', content: 'a question' }] }),
    signal: leave.signal,
  });
  assert.equal(asked.status, 200);
  const reader = asked.body.getReader();
  await reader.read();
  leave.abort();
  await pause(120);
  const atLeaving = streamed.count;
  assert.ok(atLeaving > 0 && atLeaving < 200, `it was under way when the caller left (${atLeaving})`);
  await pause(200);
  assert.ok(streamed.count <= atLeaving + 1, `it stopped asking the model (${atLeaving} then ${streamed.count})`);
});
