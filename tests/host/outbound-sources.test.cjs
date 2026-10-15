const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual search/makeTools declarations without the monolith's
// environment loading, MCP connections, signal handlers, or server startup.
const server = fs.readFileSync(path.join(__dirname, '../../server.mjs'), 'utf8');
const hosted = fs.readFileSync(path.join(__dirname, '../../functions/api/[[path]].js'), 'utf8');
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('Server search harness boundary missing');
  return source.slice(from, to);
}
const searchCode = {
  local: section(server, 'const SEARCH_ENGINE =', '// ─── MCP servers')
    + section(server, 'async function arxivSearch(', '// ─── Express App'),
  hosted: section(hosted, 'const SEARCH_BLOCKED =', '// ── routes'),
};

async function harness(kind, responses, mcpToolsets = []) {
  const [{ isWebUrl }, { tool }, { z }] = await Promise.all([
    import('../../shared/web-url.mjs'), import('ai'), import('zod'),
  ]);
  const context = vm.createContext({
    URL, AbortSignal, isWebUrl, tool, z, mcpToolsets, ZHIPU_KEY: '',
    process: { env: { SEARCH_BLOCK_DOMAINS: 'blocked.example' } },
    fetch: async (url) => {
      const next = responses.shift();
      assert.ok(next, 'Unexpected search request');
      assert.equal(new URL(url).hostname, next.host);
      return { ok: true, json: async () => next.body, text: async () => next.body };
    },
  });
  return vm.runInContext(`${searchCode[kind]}\n({ makeTools, isBlockedUrl });`, context, {
    filename: `${kind}-search-harness.mjs`,
  });
}

const providers = [
  {
    name: 'AnySearch', tool: 'web_search', prefs: { searchEngine: 'anysearch' },
    host: 'api.anysearch.com', web: true,
    response: (rows) => ({ code: 0, data: { results: rows.map((r) => ({
      title: r.title, url: r.url, snippet: r.content, date: '2026-01-02',
    })) } }),
    heading: (title) => `${title} (2026-01-02)`, content: 'Evidence',
    metadata: { date: '2026-01-02' },
  },
  {
    name: 'Zhipu', tool: 'web_search', prefs: { glm: {
      key: 'synthetic-key', endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
    } },
    host: 'open.bigmodel.cn', web: true,
    response: (rows) => ({ search_result: rows.map((r) => ({
      title: r.title, link: r.url, content: r.content,
      media: 'Fixture journal', publish_date: '2026-01-02',
    })) }),
    heading: (title) => `${title} (2026-01-02)`, content: 'Evidence',
    metadata: { date: '2026-01-02', media: 'Fixture journal' },
  },
  {
    name: 'arXiv', tool: 'arxiv_search', prefs: {},
    host: 'export.arxiv.org',
    response: (rows) => `<feed>${rows.map((r) => `<entry><title>${r.title}</title>`
      + `<id>${r.url}</id><summary>${r.content}</summary>`
      + '<published>2026-01-02T00:00:00Z</published><author><name>A. Researcher</name></author>'
      + '</entry>').join('')}</feed>`,
    heading: (title) => `${title} — A. Researcher (2026-01-02)`, content: 'Evidence',
    metadata: { date: '2026-01-02', media: 'arXiv', authors: 'A. Researcher' },
  },
  {
    name: 'Semantic Scholar', tool: 'semantic_scholar', prefs: {},
    host: 'api.semanticscholar.org',
    response: (rows) => ({ data: rows.map((r) => ({
      title: r.title, url: r.url, abstract: r.content, year: 2026,
      citationCount: 7, authors: [{ name: 'A. Researcher' }],
    })) }),
    heading: (title) => `${title} — A. Researcher (2026)`, content: 'Evidence (cited 7×)',
    metadata: { date: '2026', media: 'Semantic Scholar', authors: 'A. Researcher' },
  },
];

const unsafeUrls = [
  'javascript:alert(1)', 'data:text/html,fixture', 'file:///fixture',
  'smb://example.com/share', 'ssh://example.com', 'mailto:reader@example.com',
  'ftp://example.com/paper', 'thoughtdag://fixture', '/relative', '//example.com/paper',
  'https:example.com', 'https://', 'https://[broken',
  'https://exa mple.com', 'https://example.com/a\tb', 'https://example.com/a\nb',
  '', null, undefined, 123, { href: 'https://example.com' },
];

for (const kind of ['local', 'hosted']) {
  for (const provider of providers) {
    test(`${kind} ${provider.name}: strip unsafe source URLs and numbered links without losing evidence`, async () => {
      // Removing the central URL guard must fail this test for every provider.
      const inputs = provider.name === 'arXiv'
        ? unsafeUrls.filter((url) => typeof url === 'string')
        : [...unsafeUrls, ' https://example.com/paper', 'https://example.com/paper '];
      const sources = [];
      const responses = [];
      const { makeTools, isBlockedUrl } = await harness(kind, responses);
      const tools = makeTools(sources, null, {
        web: true, anysearchKey: 'synthetic-key', ...provider.prefs, mcp: false,
      });
      for (const unsafe of inputs) {
        const start = sources.length;
        const rows = [
          { title: 'First', url: 'https://example.com/first', content: 'Evidence' },
          { title: 'Unlinked', url: unsafe, content: 'Evidence' },
          { title: 'Last', url: 'HTTP://example.com/last', content: 'Evidence' },
        ];
        if (provider.web) {
          rows.splice(1, 0,
            { title: 'Blocked default', url: 'https://sub.zhihu.com/item', content: 'Omitted' },
            { title: 'Blocked second', url: kind === 'local'
              ? 'HTTPS://sub.blocked.example/item' : 'HTTPS://sub.doc88.com/item', content: 'Omitted' });
        }
        responses.push({ host: provider.host, body: provider.response(rows) });
        const output = await tools[provider.tool].execute({ query: 'synthetic research' });
        const added = sources.slice(start);
        assert.equal(added.length, 3, 'Keep source records and existing domain filtering');
        assert.equal(added[1].url, undefined, 'Unsafe URL must not enter accumulated sources');
        assert.deepEqual(JSON.parse(JSON.stringify(added)), [
          { title: 'First', url: 'https://example.com/first', content: provider.content, ...provider.metadata },
          { title: 'Unlinked', content: provider.content, ...provider.metadata },
          { title: 'Last', url: 'HTTP://example.com/last', content: provider.content, ...provider.metadata },
        ]);
        assert.equal(output, [
          `[${start + 1}] ${provider.heading('First')}\nhttps://example.com/first\n${provider.content}`,
          `[${start + 2}] ${provider.heading('Unlinked')}\n\n${provider.content}`,
          `[${start + 3}] ${provider.heading('Last')}\nHTTP://example.com/last\n${provider.content}`,
        ].join('\n\n'));
      }
      assert.equal(responses.length, 0);
      assert.equal(isBlockedUrl('https://zhihu.com/item'), true);
      assert.equal(isBlockedUrl('https://zhihu.com.example.org/item'), false);
      assert.equal(isBlockedUrl('not a URL'), false);
      assert.equal(isBlockedUrl('https://blocked.example/item'), kind === 'local');
    });
  }

  test(`${kind}: mixed searches retain global numbering${kind === 'local' ? ' without accumulating MCP results' : ''}`, async () => {
    const sources = [];
    const responses = [];
    const mcpResult = { content: [{ type: 'text', text: 'MCP evidence' }], url: 'smb://example.com/mcp' };
    const { makeTools } = await harness(kind, responses, [{
      server: 'fixture', tools: { lookup: { execute: async () => mcpResult } },
    }]);
    const tools = makeTools(sources, null, {
      web: true, searchEngine: 'anysearch', anysearchKey: 'synthetic-key',
    });
    for (const provider of [providers[0], providers[2], providers[3]]) {
      const start = sources.length;
      responses.push({ host: provider.host, body: provider.response([
        { title: 'Unlinked', url: 'smb://example.com/evidence', content: 'Evidence' },
        { title: 'Web', url: 'https://example.com/evidence', content: 'Evidence' },
      ]) });
      const output = await tools[provider.tool].execute({ query: 'synthetic research' });
      assert.equal(sources.length, start + 2);
      assert.equal(sources[start].url, undefined);
      assert.equal(output, [
        `[${start + 1}] ${provider.heading('Unlinked')}\n\n${provider.content}`,
        `[${start + 2}] ${provider.heading('Web')}\nhttps://example.com/evidence\n${provider.content}`,
      ].join('\n\n'));
      if (kind === 'local') {
        const beforeMcp = JSON.stringify(sources);
        assert.equal(await tools.fixture_lookup.execute({ query: 'fixture' }, {}), mcpResult);
        assert.equal(JSON.stringify(sources), beforeMcp, 'MCP forwards its result without accumulating sources');
      }
    }
    assert.equal(sources.length, 6);
    assert.equal(responses.length, 0);
  });
}
