/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchProbe, recorded, redact, REPO } from './helpers/outbound-harness';

// These are real Chromium input events in the real Electron shell. The
// startup recorder runs before main.js; no scheme ever reaches the OS.
let base: string;
let app: ElectronApplication;
let page: Page;
let runtime: { isPackaged: boolean; platform: string; arch: string; electron: string; chrome: string };
const gestures = [
  { name: 'middle-click', options: { button: 'middle' as const } },
  { name: 'Shift-click', options: { modifiers: ['Shift' as const] } },
];
const blocked = [
  'smb://example.invalid/share', 'ssh://example.invalid', 'tel:+15555550100',
  'irc://example.invalid/channel', 'ircs://example.invalid/channel', 'xmpp:user@example.invalid',
  'someapp://do/something', 'thoughtdag://open?session=abcd1234',
];

test.beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-outbound-')));
  app = await launchProbe(base);
  runtime = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, platform: process.platform,
    arch: process.arch, electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '' }));
  expect(runtime.isPackaged).toBe(Boolean(process.env.TDAG_PACKAGED_EXECUTABLE));
  expect(runtime.arch).toBe(process.arch);
  expect(runtime.electron).toBe(JSON.parse(fs.readFileSync(path.join(REPO, 'desktop/node_modules/electron/package.json'), 'utf8')).version);
  page = await app.firstWindow({ timeout: 20_000 });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
  // Fail closed if someone accidentally points the probe at an ordinary app.
  expect(await recorded(app)).toBeTruthy();
});
test.afterAll(async () => {
  await app?.close();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});
// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures before TestInfo.
test.afterEach(async ({}, info) => {
  if (app) {
    const file = info.outputPath('outbound-recorder.json');
    fs.writeFileSync(file, redact({ runtime, ...await recorded(app) }, base));
    await info.attach('outbound-recorder.json', { path: file, contentType: 'application/json' });
  }
});

async function link(url: string, target = '') {
  await page.evaluate(({ url, target }) => {
    document.getElementById('tdag-outbound-link')?.remove();
    const a = document.createElement('a');
    a.id = 'tdag-outbound-link'; a.href = url; a.target = target;
    a.textContent = 'outbound probe';
    a.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483647;background:white;padding:20px';
    document.body.appendChild(a);
  }, { url, target });
  return page.locator('#tdag-outbound-link');
}

for (const gesture of gestures) {
  test(`${gesture.name} blocks outbound non-web schemes for plain and blank-target links`, async () => {
    const before = await recorded(app);
    const appUrl = page.url();
    for (const target of ['', '_blank']) {
      for (const url of blocked) {
        await (await link(url, target)).click(gesture.options);
        // Positive handler evidence; an empty recorder alone cannot prove denial.
        await expect.poll(async () => (await recorded(app)).windows.at(-1)?.url).toBe(url);
      }
    }
    const seen = await recorded(app);
    expect(seen.windows.slice(before.windows.length)).toHaveLength(blocked.length * 2);
    expect(seen.windows.slice(before.windows.length).every((w) => w.action === 'deny')).toBe(true);
    expect(seen.external.slice(before.external.length)).toEqual([]);
    expect(app.windows()).toHaveLength(1);
    expect(page.url()).toBe(appUrl);
  });

  test(`${gesture.name} keeps HTTP HTTPS mail and OAuth working and normalizes uppercase HTTPS`, async () => {
    const before = await recorded(app);
    const urls = ['http://example.invalid/plain', 'https://example.invalid/secure',
      'mailto:someone@example.invalid', 'HTTPS://EXAMPLE.INVALID/UpperCase?Keep=Case',
      'https://example.invalid/auth?callback_url=' + encodeURIComponent(new URL('/oauth/callback', page.url()).href)];
    for (const target of ['', '_blank']) {
      for (const url of urls) {
        await (await link(url, target)).click(gesture.options);
        await expect.poll(async () => (await recorded(app)).external.at(-1)).toBe(new URL(url).href);
      }
    }
    const expected = [...urls, ...urls].map((url) => new URL(url).href);
    const seen = await recorded(app);
    expect(seen.external.slice(before.external.length)).toEqual(expected);
    expect(seen.windows.slice(before.windows.length).map((w) => w.url)).toEqual(expected);
    expect(app.windows()).toHaveLength(1);
  });
}

test('uppercase HTTPS is normalized before window.open and navigation guards', async () => {
  const before = await recorded(app);
  const raw = 'HTTPS://EXAMPLE.INVALID/UpperCase?Keep=Case';
  const normalized = new URL(raw).href;
  await page.evaluate((url) => { window.open(url); }, raw);
  await expect.poll(async () => (await recorded(app)).windows.at(-1)?.url).toBe(normalized);
  await (await link(raw, '_blank')).click();
  await expect.poll(async () => (await recorded(app)).windows.length).toBe(before.windows.length + 2);
  await (await link(raw)).click({ noWaitAfter: true });
  await expect.poll(async () => (await recorded(app)).navigation.at(-1)).toEqual({
    event: 'will-navigate', url: normalized, prevented: true,
  });
  expect((await recorded(app)).external.slice(before.external.length)).toEqual([normalized, normalized, normalized]);
  // Chromium has cancelled the navigation; reset Playwright's scheduled
  // navigation bookkeeping before a subsequent locator action.
  await page.reload();
});

test('file links are refused by Chromium before the window handler on auxiliary gestures', async () => {
  const before = await recorded(app);
  const errors: string[] = [];
  const listener = (message: { text(): string }) => { if (message.text().includes('Not allowed to load local resource')) errors.push(message.text()); };
  page.on('console', listener);
  try {
    for (const gesture of gestures) {
      const n = errors.length;
      await (await link('file:///tdag-probe-does-not-exist.txt')).click(gesture.options);
      await expect.poll(() => errors.length).toBeGreaterThan(n);
    }
    const seen = await recorded(app);
    expect(seen.external).toEqual(before.external);
    expect(seen.windows).toEqual(before.windows);
  } finally { page.off('console', listener); }
});

test('OS-delivered thoughtdag deep links retain the preload delivery path', async () => {
  const before = await recorded(app);
  await page.evaluate(`window.__tdagDeepLinks = []; window.desktopSessions.onDeepLink(url => window.__tdagDeepLinks.push(url))`);
  const url = 'thoughtdag://open?session=outbound-probe';
  const prevented = await app.evaluate(({ app }, value) => {
    let prevented = false;
    app.emit('open-url', { preventDefault() { prevented = true; } }, value);
    return prevented;
  }, url);
  expect(prevented).toBe(true);
  await expect.poll(() => page.evaluate('window.__tdagDeepLinks')).toContain(url);
  expect((await recorded(app)).external).toEqual(before.external);
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructured fixtures before TestInfo.
test('Markdown local paths stay local on primary middle and Shift clicks; right-click is unchanged', async ({}, info) => {
  // Bundle only the production component as a probe, without rebuilding dist
  // or depending on a private React/Zustand hook in the installed client.
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Markdown} from './src/components/Markdown';
    window.tdagRenderMarkdown = (root, text, base) => createRoot(root).render(React.createElement(Markdown, {base}, text));`;
  const mutation = process.env.TDAG_MARKDOWN_MUTATION;
  if (mutation && mutation !== 'remove-aux-guard') throw new Error(`Unknown Markdown mutation: ${mutation}`);
  const bundle = await build({ stdin: { contents: entry, resolveDir: REPO, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    plugins: mutation ? [{ name: 'remove-local-aux-guard', setup(b) {
      b.onLoad({ filter: /Markdown\.tsx$/ }, (args) => {
        const source = fs.readFileSync(args.path, 'utf8');
        if (!source.includes('onAuxClick=')) throw new Error('No aux guard found to mutate');
        return { contents: source.replace(/onAuxClick=/g, 'data-removed-aux-guard='), loader: 'tsx' };
      });
    } }] : [],
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' }, logLevel: 'silent' });
  await page.evaluate(bundle.outputFiles[0].text);
  const local = path.join(base, 'note.md');
  fs.writeFileSync(local, 'fixture');
  const rows = [];
  for (const [name, href, cwd] of [['absolute', local, undefined], ['relative', './note.md', base], ['home', '~/tdag-probe-missing.md', undefined]] as const) {
    await page.evaluate(({ name, href, cwd }) => {
      document.getElementById('tdag-outbound-link')?.remove();
      document.getElementById('tdag-markdown')?.remove();
      const root = document.createElement('div'); root.id = 'tdag-markdown';
      root.style.cssText = 'position:fixed;left:10px;top:10px;z-index:2147483647;background:white;padding:20px';
      document.body.appendChild(root);
      (window as unknown as { tdagRenderMarkdown(root: HTMLElement, text: string, cwd?: string): void }).tdagRenderMarkdown(root, `[${name}](${href})`, cwd);
    }, { name, href, cwd });
    const a = page.locator('#tdag-markdown a');
    await expect(a).toHaveAttribute('data-local-path', name === 'home' ? href : local);
    for (const gesture of [{ name: 'primary-click', options: {} }, ...gestures, { name: 'right-click', options: { button: 'right' as const } }]) {
      const before = await recorded(app);
      const resolved = await a.evaluate((a) => (a as HTMLAnchorElement).href);
      await a.click(gesture.options);
      if (gesture.name !== 'right-click') {
        await expect.poll(async () => (await recorded(app)).localRequests.length).toBe(before.localRequests.length + 1);
        if (name !== 'home') await expect.poll(async () => (await recorded(app)).local.length).toBe(before.local.length + 1);
      } else {
        await page.keyboard.press('Escape');
      }
      const after = await recorded(app);
      rows.push({ name, gesture: gesture.name, href, resolved,
        windows: after.windows.slice(before.windows.length), navigation: after.navigation.slice(before.navigation.length),
        external: after.external.slice(before.external.length), local: after.local.slice(before.local.length),
        localRequests: after.localRequests.slice(before.localRequests.length) });
      expect(after.external).toEqual(before.external);
      expect(after.windows).toEqual(before.windows);
      expect(after.navigation).toEqual(before.navigation);
      expect(after.localRequests.slice(before.localRequests.length)).toEqual(gesture.name === 'right-click' ? [] : [name === 'home' ? href : local]);
    }
  }
  const file = info.outputPath('markdown-local-paths.json');
  fs.writeFileSync(file, redact(rows, base));
  await info.attach('markdown-local-paths.json', { path: file, contentType: 'application/json' });
});
