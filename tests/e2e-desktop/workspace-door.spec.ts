import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The workspace door in the real desktop shell: preload bridge, IPC, the
// sender check and the service behind it, on a throwaway profile and a
// synthetic project folder. The system folder picker is the one thing
// replaced: it answers with the test's folder.

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
      // no real session stores: the atlas is pointed at nothing
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, project);
    page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
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

  // Last: this sends the app window somewhere else.
  test('another page shown in the app window has the bridge and is refused at the door', async () => {
    await page.evaluate(`location.href = ${json(otherUrl)}`);
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

  // What the plan requires of every door into the shell, stated for the
  // older agents bridge. It fails today: that bridge has no sender check, so
  // a page the window was sent to is answered. Kept as an expected failure
  // (TDAG_SHOW_GAPS=1 shows it); the fix is not part of the workspace door.
  test('[gap] the agents bridge refuses a page that is not the app', async () => {
    test.fail(!process.env.TDAG_SHOW_GAPS, 'the older bridges do not check who is calling');
    expect(page.url()).toBe(otherUrl);
    const result = await settle('window.desktopAgents.workspace("probe")');
    expect(result.ok).toBe(false);
  });
});
