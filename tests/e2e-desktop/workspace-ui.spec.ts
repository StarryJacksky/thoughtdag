import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// The file panel and file nodes in the real desktop shell, driven the way a
// person drives them: the panel, the tree, the two ways of creating a file,
// typing into a file from its node, and what the canvas shows when another
// program changes, moves or deletes a file. A throwaway profile and a
// synthetic project folder. The system folder picker answers with that
// folder, the system trash is off, and "show in file manager" only records
// what it was asked to show, so nothing opens on the person's desktop.

const REPO = path.resolve(import.meta.dirname, '..', '..');
const electronBinary = createRequire(import.meta.url)(path.join(REPO, 'desktop', 'node_modules', 'electron')) as string;

let base: string;
let project: string;
let app: ElectronApplication;
let page: Page;

const onDisk = (...parts: string[]) => path.join(project, ...parts);
const read = (...parts: string[]) => fs.readFileSync(onDisk(...parts), 'utf8');
const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
/** The node on the canvas that references the file of this name. */
const nodeOf = (name: string): Locator => page.locator('[data-resource-node]', { has: page.locator('[data-resource-name]', { hasText: exact(name) }) });
const treeFile = (name: string) => page.locator(`[data-tree-file="${name}"]`);
const treeFolder = (name: string) => page.locator(`[data-tree-folder="${name}"]`);
const nodes = () => page.locator('[data-resource-node]');

// This file is compiled without the browser's types (it runs in Node), so
// the little of the page it touches from inside is described here.
type Box = { left: number; top: number; width: number; height: number };
type PageElement = { getBoundingClientRect(): Box; dispatchEvent(event: object): boolean };
type PageGlobals = {
  DataTransfer: new () => { setData(type: string, data: string): void };
  DragEvent: new (type: string, init: object) => object;
  document: { querySelector(selector: string): PageElement | null };
  localStorage: { setItem(key: string, value: string): void };
};
const markLessonSeen = (target: Page) => target.evaluate(() => (globalThis as unknown as PageGlobals).localStorage.setItem('thoughtdag.tutorialDone', '1'));

/** Drag one element onto another the way the browser reports it: one transfer object carried from the first event to the last. */
async function drag(source: Locator, target: Locator, at?: { x: number; y: number }) {
  const [from, to] = [await source.elementHandle(), await target.elementHandle()];
  await page.evaluate(([src, dst, point]) => {
    const dom = globalThis as unknown as PageGlobals;
    const [start, end] = [src as unknown as PageElement, dst as unknown as PageElement];
    const data = new dom.DataTransfer();
    const box = end.getBoundingClientRect();
    const where = point ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const fire = (el: PageElement, type: string) => el.dispatchEvent(new dom.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: where.x, clientY: where.y }));
    fire(start, 'dragstart');
    fire(end, 'dragover');
    fire(end, 'drop');
    fire(start, 'dragend');
  }, [from, to, at ?? null] as const);
}

test.describe.serial('workspace files on the canvas, in the desktop shell', () => {
  test.beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-ui-')));
    project = path.join(base, 'research-project');
    fs.mkdirSync(path.join(project, 'notes'), { recursive: true });
    fs.writeFileSync(onDisk('notes', 'a.md'), 'FIRST_TEXT_B3\n');

    app = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(base, 'profile')}`],
      cwd: REPO,
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await app.evaluate(({ dialog, shell }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      shell.trashItem = async () => { throw new Error('the system trash is off in tests'); };
      const shown: string[] = [];
      (globalThis as unknown as { __shown: string[] }).__shown = shown;
      shell.showItemInFolder = (target: string) => { shown.push(target); };
    }, project);
    page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    // the first-launch lesson would cover the canvas: mark it as seen, as closing it does
    await markLessonSeen(page);
    await page.reload();
    await page.locator('[data-workspace-toggle]').waitFor();
  });

  test.afterAll(async () => {
    await app?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  test('the file panel opens the folder the person picks and shows what is in it', async () => {
    await page.locator('[data-workspace-toggle]').click();
    await expect(page.locator('[data-workspace-empty]')).toBeVisible();
    await page.locator('[data-open-folder]').click();
    await expect(page.locator('[data-workspace-name]')).toHaveText('research-project');
    await treeFolder('notes').click();
    await expect(treeFile('a.md')).toBeVisible();
    // the app's own record-keeping folder is not part of the tree
    await expect(page.locator('[data-tree] [data-tree-folder]')).toHaveCount(1);
  });

  test('a file created from the tree lands in the selected folder and puts nothing on the canvas', async () => {
    await expect(page.locator('[data-tree-target]')).toHaveText('notes');
    await page.locator('[data-tree-new-file]').click();
    await page.locator('[data-create-file-menu] [data-file-type="tex"]').click();
    await expect(treeFile('Untitled-001.tex')).toBeVisible();
    expect(fs.existsSync(onDisk('notes', 'Untitled-001.tex'))).toBe(true);
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });

  test('a file added from the tree becomes a node that references it, wired to nothing', async () => {
    await treeFile('a.md').hover();
    await treeFile('a.md').locator('[data-tree-add]').click();
    const node = nodeOf('a.md');
    await expect(node).toHaveAttribute('data-resource-node', 'ready');
    await expect(node.locator('[data-resource-path]')).toHaveText('notes/a.md');
    await expect(node.locator('[data-resource-preview]')).toContainText('FIRST_TEXT_B3');
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  });

  test('showing a file in the file manager names the real file and opens nothing', async () => {
    await nodeOf('a.md').locator('[data-resource-reveal]').click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown)).toEqual([onDisk('notes', 'a.md')]);
  });

  test('a file created from the graph lands in Graph Files with one node for it, and the type picked last is offered first', async () => {
    await page.locator('[data-palette-new-file]').click();
    const menu = page.locator('[data-create-file-menu]');
    await expect(menu.locator('[data-file-type]').first()).toHaveAttribute('data-file-type', 'tex');
    await menu.locator('[data-file-type="md"]').click();
    const node = nodeOf('Untitled-001.md');
    await expect(node).toHaveAttribute('data-resource-node', 'ready');
    await expect(node.locator('[data-resource-path]')).toHaveText('Graph Files/Untitled-001.md');
    expect(fs.readdirSync(onDisk('Graph Files'))).toEqual(['Untitled-001.md']);
    await expect(nodes()).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  });

  test('the new file can be typed into from its node, and what is typed lands on disk', async () => {
    const node = nodeOf('Untitled-001.md');
    await node.locator('[data-resource-edit]').click();
    await node.locator('[data-resource-editor]').fill('TYPED_HERE_W7\n');
    await node.locator('[data-resource-save]').click();
    await expect.poll(() => read('Graph Files', 'Untitled-001.md')).toBe('TYPED_HERE_W7\n');
    await node.locator('[data-resource-done]').click();
    await expect(node.locator('[data-resource-preview]')).toContainText('TYPED_HERE_W7');
  });

  test('a save does not land on top of another program\'s change until the person says so', async () => {
    const node = nodeOf('Untitled-001.md');
    await node.locator('[data-resource-edit]').click();
    await node.locator('[data-resource-editor]').fill('MINE_Z5\n');
    fs.writeFileSync(onDisk('Graph Files', 'Untitled-001.md'), 'CHANGED_ELSEWHERE_M2\n');
    await node.locator('[data-resource-save]').click();
    await expect(node.locator('[data-resource-conflict]')).toBeVisible();
    expect(read('Graph Files', 'Untitled-001.md')).toBe('CHANGED_ELSEWHERE_M2\n');
    await expect(node.locator('[data-resource-editor]')).toHaveValue('MINE_Z5\n');
    await node.locator('[data-conflict-overwrite]').click();
    await expect.poll(() => read('Graph Files', 'Untitled-001.md')).toBe('MINE_Z5\n');
    await node.locator('[data-resource-done]').click();
  });

  test('an edit by another program shows up in the node that references the file', async () => {
    fs.writeFileSync(onDisk('notes', 'a.md'), 'EXTERNAL_EDIT_E6\n');
    await expect(nodeOf('a.md').locator('[data-resource-preview]')).toContainText('EXTERNAL_EDIT_E6', { timeout: 20_000 });
  });

  test('dragging a node\'s path onto a folder moves the file there, and the node shows the new place', async () => {
    await drag(nodeOf('Untitled-001.md').locator('[data-resource-path]'), treeFolder('notes'));
    await expect(nodeOf('Untitled-001.md').locator('[data-resource-path]')).toHaveText('notes/Untitled-001.md');
    expect(read('notes', 'Untitled-001.md')).toBe('MINE_Z5\n');
    expect(fs.existsSync(onDisk('Graph Files', 'Untitled-001.md'))).toBe(false);
    await expect(nodes()).toHaveCount(2);
  });

  test('a file dragged from the tree onto the canvas becomes a node, and removing the node leaves the file', async () => {
    await drag(treeFile('Untitled-001.tex'), page.locator('.react-flow__pane'), { x: 900, y: 220 });
    const node = nodeOf('Untitled-001.tex');
    await expect(node).toHaveAttribute('data-resource-node', 'ready');
    await expect(nodes()).toHaveCount(3);
    await node.locator('[data-resource-remove]').click();
    await expect(nodes()).toHaveCount(2);
    expect(fs.existsSync(onDisk('notes', 'Untitled-001.tex'))).toBe(true);
  });

  test('a drag that names a path instead of a file is ignored', async () => {
    await page.evaluate(() => {
      const dom = globalThis as unknown as PageGlobals;
      const data = new dom.DataTransfer();
      data.setData('application/thoughtdag-resource', JSON.stringify({ kind: 'file-path', path: '/synthetic/outside/secret.txt' }));
      const pane = dom.document.querySelector('.react-flow__pane')!;
      for (const type of ['dragover', 'drop']) pane.dispatchEvent(new dom.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, clientX: 900, clientY: 220 }));
    });
    await page.waitForTimeout(300);
    await expect(nodes()).toHaveCount(2);
  });

  test('a file deleted by another program turns its node into a card for finding it, and picking the file it is now brings it back', async () => {
    fs.rmSync(onDisk('notes', 'a.md'));
    const lost = nodeOf('a.md');
    await expect(lost).toHaveAttribute('data-resource-node', 'missing', { timeout: 20_000 });
    await expect(lost.locator('[data-resource-lost]')).toBeVisible();

    fs.writeFileSync(onDisk('notes', 'b.md'), 'FOUND_AGAIN_S1\n');
    await lost.locator('[data-resource-relink]').click();
    await expect(page.locator('[data-relink-banner]')).toBeVisible();
    await page.locator('[data-tree-refresh]').click();
    await treeFile('b.md').locator('[data-tree-relink]').click();
    const found = nodeOf('b.md');
    await expect(found).toHaveAttribute('data-resource-node', 'ready');
    await expect(found.locator('[data-resource-path]')).toHaveText('notes/b.md');
    await expect(found.locator('[data-resource-preview]')).toContainText('FOUND_AGAIN_S1');
    await expect(page.locator('[data-relink-banner]')).toHaveCount(0);
    await expect(nodes()).toHaveCount(2);
  });

  test('the space entry says it cannot be opened and offers a copy, which lands as an ordinary file marked as a copy', async () => {
    await page.locator('[data-tree-open]').click();
    await page.locator('[data-open-space]').click();
    await expect(page.locator('[data-space-notice]')).toBeVisible();
    await page.locator('[data-space-import]').click();
    const dialog = page.locator('[data-import-copy]');
    await expect(dialog.locator('[data-import-source]')).toHaveValue('chatgpt-space');
    await dialog.locator('[data-import-name]').fill('space-page');
    await dialog.locator('[data-import-note]').fill('Reading list');
    await dialog.locator('[data-import-text]').fill('COPIED_FROM_SPACE_H9\n');
    await dialog.locator('[data-import-save]').click();
    await expect(treeFile('space-page.md')).toBeVisible();
    expect(read('notes', 'space-page.md')).toBe('COPIED_FROM_SPACE_H9\n');

    await treeFile('space-page.md').dblclick();
    const node = nodeOf('space-page.md');
    await expect(node).toHaveAttribute('data-resource-node', 'ready');
    await expect(node.locator('[data-resource-copy]')).toBeVisible();
    await expect(nodes()).toHaveCount(3);
  });

  test('after the page is loaded again the canvas still has its folder and its file nodes', async () => {
    await page.waitForTimeout(2500); // the canvas is saved a moment after the last change
    await page.reload();
    await expect(nodes()).toHaveCount(3);
    for (const name of ['b.md', 'Untitled-001.md', 'space-page.md']) await expect(nodeOf(name)).toHaveAttribute('data-resource-node', 'ready');
    await page.locator('[data-workspace-toggle]').click();
    await expect(page.locator('[data-workspace-name]')).toHaveText('research-project');
    await expect(treeFolder('notes')).toBeVisible();
    // and it still hears about the folder: a change made now reaches the node
    fs.writeFileSync(onDisk('notes', 'b.md'), 'AFTER_RELOAD_P4\n');
    await expect(nodeOf('b.md').locator('[data-resource-preview]')).toContainText('AFTER_RELOAD_P4', { timeout: 20_000 });
  });

  test('a file too large to copy in, and one that is no kind that can be read, are nodes that say so and hold no content', async () => {
    fs.writeFileSync(onDisk('notes', 'huge.csv'), Buffer.alloc(8 * 1024 * 1024 + 1, 'a'));
    fs.writeFileSync(onDisk('notes', 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    await treeFolder('notes').click(); // the tree starts closed after the reload
    await expect(treeFile('blob.bin')).toBeVisible();
    for (const [name, why] of [['huge.csv', 'too-large'], ['blob.bin', 'unreadable']] as const) {
      await treeFile(name).dblclick();
      const node = nodeOf(name);
      await expect(node.locator('[data-resource-no-copy]')).toHaveAttribute('data-resource-no-copy', why);
      await expect(node.locator('[data-resource-edit]')).toHaveCount(0);
      await node.locator('[data-resource-remove]').click();
    }
    expect(fs.statSync(onDisk('notes', 'huge.csv')).size).toBe(8 * 1024 * 1024 + 1);
  });
});

test.describe.serial('folders in the file panel, in the desktop shell', () => {
  let folderBase: string;
  let folderProject: string;
  let folderApp: ElectronApplication;
  let p: Page;
  const disk = (...parts: string[]) => path.join(folderProject, ...parts);
  const file = (name: string) => p.locator(`[data-tree-file="${name}"]`);
  const dir = (name: string) => p.locator(`[data-tree-folder="${name}"]`);
  const fileNode = (name: string) => p.locator('[data-resource-node]', { has: p.locator('[data-resource-name]', { hasText: exact(name) }) });
  /** Type a name into the tree's text box and keep it. */
  const typeName = async (name: string) => { await p.locator('[data-tree-name-box]').fill(name); await p.keyboard.press('Enter'); };

  test.beforeAll(async () => {
    folderBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-folders-')));
    folderProject = path.join(folderBase, 'research-project');
    fs.mkdirSync(path.join(folderProject, 'notes'), { recursive: true });
    fs.writeFileSync(disk('notes', 'a.md'), 'FIRST_TEXT_B3\n');
    folderApp = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(folderBase, 'profile')}`],
      cwd: REPO,
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await folderApp.evaluate(({ dialog, shell }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      shell.trashItem = async () => { throw new Error('the system trash is off in tests'); };
    }, folderProject);
    p = await folderApp.firstWindow();
    await p.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    await markLessonSeen(p);
    await p.reload();
    await p.locator('[data-workspace-toggle]').click();
    await p.locator('[data-open-folder]').click();
    await dir('notes').click();
    await file('a.md').dblclick();
    await expect(fileNode('a.md')).toHaveAttribute('data-resource-node', 'ready');
  });

  test.afterAll(async () => {
    await folderApp?.close();
    if (folderBase) fs.rmSync(folderBase, { recursive: true, force: true });
  });

  test('a folder is made where the person is in the tree, under the name they type', async () => {
    await p.locator('[data-tree]').click({ position: { x: 200, y: 400 } }); // the top of the folder
    await p.locator('[data-tree-new-folder]').click();
    await typeName('archive');
    await expect(dir('archive')).toBeVisible();
    expect(fs.statSync(disk('archive')).isDirectory()).toBe(true);
  });

  test('a file renamed in the tree is the same file under its new name, and the node that references it says so', async () => {
    await file('a.md').hover();
    await file('a.md').locator('[data-tree-rename]').click();
    await typeName('reading.md');
    await expect(file('reading.md')).toBeVisible();
    expect(fs.readFileSync(disk('notes', 'reading.md'), 'utf8')).toBe('FIRST_TEXT_B3\n');
    expect(fs.existsSync(disk('notes', 'a.md'))).toBe(false);
    await expect(fileNode('reading.md').locator('[data-resource-path]')).toHaveText('notes/reading.md');
    await expect(fileNode('reading.md')).toHaveAttribute('data-resource-node', 'ready');
  });

  test('a copy made in the tree is a second file beside the first; the first is untouched', async () => {
    await file('reading.md').hover();
    await file('reading.md').locator('[data-tree-duplicate]').click();
    await expect(p.locator('[data-tree] [data-tree-file]')).toHaveCount(2);
    const made = fs.readdirSync(disk('notes')).filter((name) => name !== 'reading.md');
    expect(made.length).toBe(1);
    expect(made[0].endsWith('.md')).toBe(true);
    expect(fs.readFileSync(disk('notes', made[0]), 'utf8')).toBe('FIRST_TEXT_B3\n');
  });

  test('a folder renamed in the tree takes its files with it, and their nodes follow', async () => {
    await dir('notes').hover();
    await dir('notes').locator('[data-tree-rename]').click();
    await typeName('reading-notes');
    await expect(dir('reading-notes')).toBeVisible();
    expect(fs.existsSync(disk('notes'))).toBe(false);
    expect(fs.readFileSync(disk('reading-notes', 'reading.md'), 'utf8')).toBe('FIRST_TEXT_B3\n');
    await expect(fileNode('reading.md').locator('[data-resource-path]')).toHaveText('reading-notes/reading.md');
  });

  test('a folder dragged onto another goes inside it, files and all', async () => {
    const [from, to] = [await dir('reading-notes').elementHandle(), await dir('archive').elementHandle()];
    await p.evaluate(([src, dst]) => {
      const dom = globalThis as unknown as PageGlobals;
      const [start, end] = [src as unknown as PageElement, dst as unknown as PageElement];
      const data = new dom.DataTransfer();
      const box = end.getBoundingClientRect();
      const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
      for (const [el, type] of [[start, 'dragstart'], [end, 'dragover'], [end, 'drop'], [start, 'dragend']] as const) el.dispatchEvent(new dom.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ...at }));
    }, [from, to] as const);
    await expect(fileNode('reading.md').locator('[data-resource-path]')).toHaveText('archive/reading-notes/reading.md');
    expect(fs.readFileSync(disk('archive', 'reading-notes', 'reading.md'), 'utf8')).toBe('FIRST_TEXT_B3\n');
    expect(fs.existsSync(disk('reading-notes'))).toBe(false);
  });

  test('a trashed folder is kept in the recovery area, its file\'s node says the file is missing, and putting it back brings both back', async () => {
    await dir('archive').hover();
    await dir('archive').locator('[data-tree-trash]').click();
    await p.locator('button.bg-red-500').click(); // the confirmation
    await expect(fileNode('reading.md')).toHaveAttribute('data-resource-node', 'missing');
    expect(fs.existsSync(disk('archive'))).toBe(false);

    await p.locator('[data-tree-recovery]').click();
    const item = p.locator('[data-recovery-item="archive"]');
    await expect(item).toBeVisible();
    await item.locator('[data-recovery-restore]').click();
    await expect(p.locator('[data-recovery-empty]')).toBeVisible();
    expect(fs.readFileSync(disk('archive', 'reading-notes', 'reading.md'), 'utf8')).toBe('FIRST_TEXT_B3\n');
    await expect(fileNode('reading.md')).toHaveAttribute('data-resource-node', 'ready');
    await p.locator('[data-tree-recovery]').click();
    await expect(dir('archive')).toBeVisible();
  });
});

test.describe.serial('a new canvas that starts from a file', () => {
  let freshBase: string;
  let freshApp: ElectronApplication;
  let freshPage: Page;

  test.beforeAll(async () => {
    freshBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-fresh-')));
    freshApp = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(freshBase, 'profile')}`],
      cwd: REPO,
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await freshApp.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { throw new Error('no picker is expected here'); }; });
    freshPage = await freshApp.firstWindow();
    await freshPage.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    await markLessonSeen(freshPage);
    await freshPage.reload();
    await freshPage.locator('[data-empty-canvas-palette]').waitFor();
  });

  test.afterAll(async () => {
    await freshApp?.close();
    if (freshBase) fs.rmSync(freshBase, { recursive: true, force: true });
  });

  test('with nothing on the canvas and no folder chosen, a file is created in the canvas\'s own folder, its node appears, and what is typed lands on disk', async () => {
    await expect(freshPage.locator('.react-flow__node')).toHaveCount(0);
    await freshPage.locator('[data-empty-canvas-palette] [data-palette-new-file]').click();
    await freshPage.locator('[data-create-file-menu] [data-file-type="md"]').click();
    const node = freshPage.locator('[data-resource-node]');
    await expect(node).toHaveCount(1);
    await expect(node.locator('[data-resource-path]')).toHaveText('Graph Files/Untitled-001.md');

    await node.locator('[data-resource-edit]').click();
    await node.locator('[data-resource-editor]').fill('FIRST_WORDS_Y3\n');
    await node.locator('[data-resource-save]').click();
    const workspaces = path.join(freshBase, 'profile', 'workspaces');
    const where = () => fs.readdirSync(workspaces, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith(path.join('Graph Files', 'Untitled-001.md')));
    await expect.poll(() => where().length).toBe(1);
    await expect.poll(() => fs.readFileSync(path.join(workspaces, where()[0]), 'utf8')).toBe('FIRST_WORDS_Y3\n');
    await expect(freshPage.locator('.react-flow__edge')).toHaveCount(0);
  });
});

test.describe.serial('a canvas with no folder of its own yet', () => {
  let ownBase: string;
  let ownApp: ElectronApplication;
  let ownPage: Page;

  test.beforeAll(async () => {
    ownBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-own-')));
    ownApp = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(ownBase, 'profile')}`],
      cwd: REPO,
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await ownApp.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => { throw new Error('no picker is expected here'); }; });
    ownPage = await ownApp.firstWindow();
    await ownPage.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    await markLessonSeen(ownPage);
    await ownPage.reload();
    await ownPage.locator('[data-workspace-toggle]').waitFor();
  });

  test.afterAll(async () => {
    await ownApp?.close();
    if (ownBase) fs.rmSync(ownBase, { recursive: true, force: true });
  });

  test('gets the one the shell keeps for it, with no picker, and files created there are real files inside the profile', async () => {
    await ownPage.locator('[data-workspace-toggle]').click();
    await ownPage.locator('[data-open-default]').click();
    await expect(ownPage.locator('[data-tree-new-file]')).toBeVisible();
    await ownPage.locator('[data-tree-new-file]').click();
    await ownPage.locator('[data-create-file-menu] [data-file-type="json"]').click();
    await expect(ownPage.locator('[data-tree-file="Untitled-001.json"]')).toBeVisible();

    const workspaces = path.join(ownBase, 'profile', 'workspaces');
    const found = fs.readdirSync(workspaces, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('Untitled-001.json'));
    expect(found.length).toBe(1);
    // the template for a JSON file is JSON
    expect(JSON.parse(fs.readFileSync(path.join(workspaces, found[0]), 'utf8'))).toEqual({});
  });
});
