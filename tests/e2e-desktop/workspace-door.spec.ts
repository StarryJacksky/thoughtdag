import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The workspace door in the real desktop shell: preload bridge, IPC, the
// sender check and the service behind it, on a throwaway profile and a
// synthetic project folder. Two things are replaced: the system folder
// picker answers with the test's folder, and a link handed to the system
// browser is recorded instead of opened.

const REPO = path.resolve(import.meta.dirname, '..', '..');
const electronBinary = createRequire(import.meta.url)(path.join(REPO, 'desktop', 'node_modules', 'electron')) as string;

let base: string;
let project: string;
let app: ElectronApplication;
let page: Page;
let otherSite: http.Server;
let otherUrl: string;

/** Evaluate an expression in the page and report how it settled. */
const settle = (expression: string) => page.evaluate(`(async () => { try { return { ok: true, value: await (${expression}) }; } catch (e) { return { ok: false, message: String(e && e.message) }; } })()`) as Promise<{ ok: true; value: unknown } | { ok: false; message: string }>;
const json = (value: unknown) => JSON.stringify(value);

/** What the shell did with each attempt to take the window out of the app. */
type Leaving = { attempts: { url: string; prevented: boolean }[]; external: string[] };
const leaving = () => app.evaluate(() => (globalThis as unknown as { tdagLeaving: Leaving }).tdagLeaving);

// One call into each of the older bridges, chosen to change nothing when it
// is answered: an unknown runner, a malformed id, a path that is not absolute.
const olderBridgeCalls = [
  'window.desktop.checkForUpdates()',
  'window.desktopSessions.roots()',
  'window.desktopSessions.pendingDeepLink()',
  'window.desktopSessions.commandsInstall("no-such-runner")',
  'window.desktopSessions.codexThreadRead("x")',
  'window.desktopAgents.workspace("probe")',
  'window.desktopWhy.status()',
  'window.desktopLocal.image("not-absolute.png")',
  'window.desktopCanvas.remove("!")',
];

test.describe.serial('the workspace door in the desktop shell', () => {
  test.beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-')));
    project = path.join(base, 'research-project');
    fs.mkdirSync(path.join(project, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(project, 'notes', 'a.md'), 'INSIDE_NOTE_F2');
    fs.writeFileSync(path.join(project, 'readme.md'), 'TOP_NOTE_J6');

    // a page that is not the app, on this machine: what a stray link could lead to
    otherSite = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>not the app</title><p>another page</p>'); });
    await new Promise<void>((resolve) => otherSite.listen(0, '127.0.0.1', resolve));
    otherUrl = `http://127.0.0.1:${(otherSite.address() as AddressInfo).port}/`;

    app = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(base, 'profile')}`],
      cwd: REPO,
      // no real session stores: the atlas is pointed at nothing, and the
      // shell's own records land in the throwaway folder
      env: { ...process.env, TD_SESSION_ROOTS: '{}', THOUGHTDAG_HOME: path.join(base, 'home') },
    });
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, project);
    page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    // registered after the shell's own listener, so it sees the shell's decision
    await app.evaluate(({ BrowserWindow, shell }) => {
      const seen: Leaving = { attempts: [], external: [] };
      (globalThis as unknown as { tdagLeaving: Leaving }).tdagLeaving = seen;
      shell.openExternal = async (url: string) => { seen.external.push(url); };
      BrowserWindow.getAllWindows()[0].webContents.on('will-navigate', (e: { defaultPrevented: boolean }, url: string) => {
        seen.attempts.push({ url, prevented: e.defaultPrevented });
      });
    });
  });

  test.afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => otherSite?.close(resolve));
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  let workspaceId: string;

  test('a chosen folder opens as a workspace, lists without its own records, and names no path', async () => {
    const chosen = await settle('window.desktopWorkspace.chooseRoot()');
    expect(chosen.ok, json(chosen)).toBe(true);
    const record = (chosen as { value: { workspaceId: string; kind: string; displayName: string; readOnly: boolean } }).value;
    expect(record).toMatchObject({ kind: 'local', displayName: 'research-project', readOnly: false });
    expect(json(record)).not.toContain(base);
    workspaceId = record.workspaceId;

    const listed = await settle(`window.desktopWorkspace.listChildren(${json(workspaceId)})`);
    expect(listed.ok, json(listed)).toBe(true);
    const entries = (listed as { value: { name: string; kind: string }[] }).value;
    expect(entries.map((e) => [e.name, e.kind])).toEqual([['notes', 'folder'], ['readme.md', 'file']]);
    expect(json(entries)).not.toContain(base);
  });

  test('a file gets its identity through the bridge, and the registry lands in the folder', async () => {
    const listed = await settle(`window.desktopWorkspace.listChildren(${json(workspaceId)})`) as { value: { name: string; entryId: string }[] };
    const readme = listed.value.find((e) => e.name === 'readme.md')!;
    const registered = await settle(`window.desktopWorkspace.registerEntry(${json(workspaceId)}, ${json(readme.entryId)})`);
    expect(registered.ok, json(registered)).toBe(true);
    const record = (registered as { value: { fileId: string; relativePath: string; revision: null } }).value;
    expect(record).toMatchObject({ relativePath: 'readme.md', revision: null });
    const stored = JSON.parse(fs.readFileSync(path.join(project, '.thoughtdag', 'resources.json'), 'utf8')) as { resources: { record: { fileId: string } }[] };
    expect(stored.resources.map((r) => r.record.fileId)).toEqual([record.fileId]);
  });

  test('a path that climbs out is refused by the shell, with a code and no path in the message', async () => {
    const forged = 'e_' + Buffer.from('../outside.txt').toString('base64url');
    const result = await settle(`window.desktopWorkspace.registerEntry(${json(workspaceId)}, ${json(forged)})`);
    expect(result.ok).toBe(false);
    const message = (result as { message: string }).message;
    expect(message).toContain('traversal: ');
    expect(message).not.toContain(base);
  });

  test('a frame inside the page is not given the bridge', async () => {
    const seen = await page.evaluate(`new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.src = ${json(otherUrl)};
      frame.onload = () => resolve('loaded');
      document.body.appendChild(frame);
    })`);
    expect(seen).toBe('loaded');
    const inner = page.frames().find((f) => f.url() === otherUrl)!;
    expect(await inner.evaluate('typeof window.desktopWorkspace')).toBe('undefined');
  });

  test('the older bridges answer the app itself', async () => {
    for (const expression of olderBridgeCalls) {
      const result = await settle(expression);
      expect(result.ok, expression + (result.ok ? '' : ': ' + result.message)).toBe(true);
    }
  });

  test('the window does not leave the app for another local page', async () => {
    const appUrl = page.url();
    await page.evaluate(`location.href = ${json(otherUrl)}`);
    await expect.poll(async () => (await leaving()).attempts).toContainEqual({ url: otherUrl, prevented: true });
    // a web link belongs to the system browser
    expect((await leaving()).external).toEqual([otherUrl]);

    // the address of the app, worn as a user name by another host
    const disguised = otherUrl.replace('http://', 'http://127.0.0.1:x@');
    await page.evaluate(`location.href = ${json(disguised)}`);
    await expect.poll(async () => (await leaving()).attempts).toContainEqual({ url: disguised, prevented: true });

    // back in history is the splash page, a local file
    await page.evaluate('history.back()');
    await expect.poll(async () => (await leaving()).attempts.at(-1)).toMatchObject({ url: expect.stringMatching(/^file:.*splash\.html$/), prevented: true });

    expect(page.url()).toBe(appUrl);
    expect((await settle('window.desktopWorkspace.listWorkspaces()')).ok).toBe(true);
  });

  test('the window still moves within the app', async () => {
    const appUrl = page.url();
    const loaded = page.waitForEvent('load');
    // a reload the page asks for itself, as the app does when a newer build lands
    await page.evaluate('setTimeout(() => location.reload(), 0)');
    await loaded;
    expect((await leaving()).attempts.at(-1)).toEqual({ url: appUrl, prevented: false });
    expect(page.url()).toBe(appUrl);
    expect((await settle('window.desktopWorkspace.listWorkspaces()')).ok).toBe(true);
  });

  test('a link that opens a new window reaches the system only as a web or mail link', async () => {
    const appUrl = page.url();
    const before = (await leaving()).external.length;
    // a link the way a reference under a response or a link card writes it:
    // the address comes from data, the click from the person
    await page.evaluate(`(() => {
      const link = document.createElement('a');
      link.id = 'tdag-test-link';
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'a link';
      link.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#fff';
      document.body.appendChild(link);
    })()`);
    const follow = async (url: string) => {
      await page.evaluate(`document.getElementById('tdag-test-link').href = ${json(url)}`);
      await page.click('#tdag-test-link');
    };

    // each of these would start whichever app claims the scheme
    const dropped = [
      'smb://example.invalid/share',
      'ssh://example.invalid',
      'someapp://do/something',
      'thoughtdag://open?session=abcd1234',
      'data:text/html,another page',
      'file:///etc/hosts',
    ];
    for (const url of dropped) {
      await follow(url);
      await page.evaluate(`void window.open(${json(url)})`);
    }

    const handedOver = [`${otherUrl}linked`, 'https://example.invalid/page', 'mailto:someone@example.invalid'];
    for (const url of handedOver) await follow(url);
    // window.open with a web address, as the sign-in with a model provider does
    const signIn = 'https://example.invalid/auth?callback_url=' + encodeURIComponent(new URL('/oauth/callback', appUrl).href);
    await page.evaluate(`void window.open(${json(signIn)})`);

    // requests are answered in order: once the last one is through, so are the rest
    await expect.poll(async () => (await leaving()).external).toContain(signIn);
    expect((await leaving()).external.slice(before)).toEqual([...handedOver, signIn]);

    await page.evaluate(`document.getElementById('tdag-test-link').remove()`);
    expect(app.windows()).toHaveLength(1);
    expect(page.url()).toBe(appUrl);
  });

  // Last two: a page that is not the app, in the app window. The window no
  // longer goes there by itself, so the shell is told to load it.
  test('another page shown in the app window has the bridge and is refused at the door', async () => {
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.loadURL(url), otherUrl);
    await page.waitForURL(otherUrl);
    expect(await page.evaluate('typeof window.desktopWorkspace')).toBe('object');
    for (const expression of [
      'window.desktopWorkspace.listWorkspaces()',
      `window.desktopWorkspace.listChildren(${json(workspaceId)})`,
      'window.desktopWorkspace.chooseRoot()',
    ]) {
      const result = await settle(expression);
      expect(result.ok, expression).toBe(false);
      expect((result as { message: string }).message).toContain('refused: the app window is not showing the app');
    }
  });

  test('the older bridges refuse a page that is not the app', async () => {
    expect(page.url()).toBe(otherUrl);
    for (const expression of olderBridgeCalls) {
      const result = await settle(expression);
      expect(result.ok, expression).toBe(false);
      expect((result as { message: string }).message, expression).toContain('refused: the app window is not showing the app');
    }
  });
});
