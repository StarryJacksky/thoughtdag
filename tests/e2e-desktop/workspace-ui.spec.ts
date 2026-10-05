import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { docxWith, onePixelPng, pdfWithPages } from './helpers/synthetic-files';

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
/** The surface that shows the file of this name, on a page. */
const surfaceOn = (on: Page, name: string): Locator => on.locator('[data-surface]', { has: on.locator('[data-surface-title]', { hasText: exact(name) }) });
const surfaceOf = (name: string): Locator => surfaceOn(page, name);
/** What the editor in a surface holds, line by line. */
const textIn = (surface: Locator): Promise<string> => surface.locator('.cm-content').evaluate((el) => {
  const lines = (el as unknown as { querySelectorAll(selector: string): Iterable<{ textContent: string | null }> }).querySelectorAll('.cm-line');
  return [...lines].map((line) => line.textContent ?? '').join('\n');
});
/** Replace everything in a surface's editor with `text`, typed the way a person types it: text, and Enter between lines. */
async function typeIn(surface: Locator, text: string): Promise<void> {
  const on = surface.page();
  await surface.locator('.cm-content').click();
  await on.keyboard.press('ControlOrMeta+a');
  await on.keyboard.press('Backspace');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await on.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await on.keyboard.press('Enter');
  }
}

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

    // it opens to be typed into at once, beside the canvas, and what is typed lands in the file
    const surface = surfaceOf('Untitled-001.tex');
    await expect(surface).toBeVisible();
    await typeIn(surface, '\\section{Typed from the tree}\n');
    await expect(surface.locator('[data-surface-state]')).toHaveAttribute('data-surface-state', 'clean');
    expect(read('notes', 'Untitled-001.tex')).toBe('\\section{Typed from the tree}\n');
    await expect(page.locator('.react-flow__node'), 'the canvas still has no node for it').toHaveCount(0);
    await surface.locator('[data-surface-close]').click();
    await expect(surface).toHaveCount(0);
    expect(read('notes', 'Untitled-001.tex'), 'closing the view leaves the file').toBe('\\section{Typed from the tree}\n');
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

  test('the new file is open to be typed into, its node shows what is typed, and the node\'s pencil leads to the same surface', async () => {
    const node = nodeOf('Untitled-001.md');
    const surface = surfaceOf('Untitled-001.md');
    await expect(surface, 'it opened when it was made').toBeVisible();
    await typeIn(surface, 'TYPED_HERE_W7\n');
    await surface.locator('[data-surface-save]').click();
    await expect.poll(() => read('Graph Files', 'Untitled-001.md')).toBe('TYPED_HERE_W7\n');
    await expect(node.locator('[data-resource-preview]')).toContainText('TYPED_HERE_W7');
    await node.locator('[data-resource-edit]').click();
    await expect(page.locator('[data-surface]'), 'one surface per file').toHaveCount(1);
  });

  test('a save does not land on top of another program\'s change until the person says so', async () => {
    const surface = surfaceOf('Untitled-001.md');
    await typeIn(surface, 'MINE_Z5\n');
    fs.writeFileSync(onDisk('Graph Files', 'Untitled-001.md'), 'CHANGED_ELSEWHERE_M2\n');
    // nothing is clicked: the conflict shows by itself, from the folder's news or from the save that would have followed the typing
    await expect(surface.locator('[data-surface-conflict]')).toBeVisible();
    await expect(surface.locator('[data-surface-save]')).toBeDisabled();
    expect(read('Graph Files', 'Untitled-001.md')).toBe('CHANGED_ELSEWHERE_M2\n');
    expect(await textIn(surface)).toBe('MINE_Z5\n');
    await surface.locator('[data-conflict-overwrite]').click();
    await expect.poll(() => read('Graph Files', 'Untitled-001.md')).toBe('MINE_Z5\n');
  });

  test('what is typed saves by itself a moment after the typing stops', async () => {
    const surface = surfaceOf('Untitled-001.md');
    await typeIn(surface, 'SAVED_BY_ITSELF_A2\n');
    await expect(surface.locator('[data-surface-state]')).toHaveAttribute('data-surface-state', 'clean');
    expect(read('Graph Files', 'Untitled-001.md')).toBe('SAVED_BY_ITSELF_A2\n');
    // undo is the document's: step by step the text goes back to what it was, and that is saved too
    await surface.locator('.cm-content').click();
    for (let step = 0; step < 12 && (await textIn(surface)) !== 'MINE_Z5\n'; step++) await surface.page().keyboard.press('ControlOrMeta+z');
    expect(await textIn(surface)).toBe('MINE_Z5\n');
    await expect.poll(() => read('Graph Files', 'Untitled-001.md')).toBe('MINE_Z5\n');
    await expect(nodes(), 'undoing in a document undoes nothing on the canvas').toHaveCount(2);
    await surface.locator('[data-surface-close]').click();
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

    await treeFile('space-page.md').hover();
    await treeFile('space-page.md').locator('[data-tree-add]').click();
    const node = nodeOf('space-page.md');
    await expect(node).toHaveAttribute('data-resource-node', 'ready');
    await expect(node.locator('[data-resource-copy]')).toBeVisible();
    await expect(nodes()).toHaveCount(3);
  });

  test('typing that could not be saved is not lost: it is there again after the page is loaded anew, and is saved once it can be', async () => {
    fs.chmodSync(onDisk('notes'), 0o555); // nothing can be written into the folder
    try {
      await nodeOf('space-page.md').locator('[data-resource-edit]').click();
      const surface = surfaceOf('space-page.md');
      await typeIn(surface, 'TYPED_BUT_NOT_SAVED_J7\n');
      await expect(surface.locator('[data-surface-state]')).toHaveAttribute('data-surface-state', 'readonly');
      expect(read('notes', 'space-page.md')).toBe('COPIED_FROM_SPACE_H9\n');
      await page.waitForTimeout(2500); // the canvas is saved a moment after the last change
      await page.reload();
    } finally {
      fs.chmodSync(onDisk('notes'), 0o755);
    }
    // the surface is where it was, with what was typed, and now that the folder can be written it is saved
    const again = surfaceOf('space-page.md');
    await expect.poll(() => textIn(again)).toBe('TYPED_BUT_NOT_SAVED_J7\n');
    await expect.poll(() => read('notes', 'space-page.md')).toBe('TYPED_BUT_NOT_SAVED_J7\n');
    await again.locator('[data-surface-close]').click();
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
      await treeFile(name).hover();
      await treeFile(name).locator('[data-tree-add]').click();
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
    await file('a.md').hover();
    await file('a.md').locator('[data-tree-add]').click();
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

test.describe.serial('documents open beside the canvas, in the desktop shell', () => {
  let sBase: string;
  let sProject: string;
  let sApp: ElectronApplication;
  let sp: Page;
  const NAMES = ['one.md', 'two.tex', 'three.py', 'four.txt'];
  const surface = (name: string) => surfaceOn(sp, name);
  const boxOf = async (name: string) => (await surface(name).boundingBox())!;
  /** Bring a frame in front of the others the way a person does: by pressing on whatever part of it shows past them. */
  const bringForward = async (name: string) => {
    const id = await surface(name).getAttribute('data-surface');
    const point = await sp.evaluate((surfaceId) => {
      type El = { closest(selector: string): { getAttribute(name: string): string | null } | null; getBoundingClientRect(): Box };
      const dom = globalThis as unknown as { document: { querySelector(selector: string): El | null; elementFromPoint(x: number, y: number): El | null } };
      const box = dom.document.querySelector(`[data-surface="${surfaceId}"]`)!.getBoundingClientRect();
      // along the frame's edges first: that is where a covered frame shows
      for (let y = box.top + 6; y < box.top + box.height; y += 12) {
        for (let x = box.left + 6; x < box.left + box.width; x += 12) {
          if (dom.document.elementFromPoint(x, y)?.closest('[data-surface]')?.getAttribute('data-surface') === surfaceId) return { x, y };
        }
      }
      return null;
    }, id);
    expect(point, `some part of ${name} shows`).not.toBeNull();
    await sp.mouse.click(point!.x, point!.y);
  };

  test.beforeAll(async () => {
    sBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-surfaces-')));
    sProject = path.join(sBase, 'research-project');
    fs.mkdirSync(sProject, { recursive: true });
    for (const name of NAMES) fs.writeFileSync(path.join(sProject, name), `content of ${name}\n`);
    sApp = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(sBase, 'profile')}`],
      cwd: REPO,
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await sApp.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] }); }, sProject);
    sp = await sApp.firstWindow();
    await sp.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    await markLessonSeen(sp);
    await sp.reload();
    await sp.locator('[data-workspace-toggle]').click();
    await sp.locator('[data-open-folder]').click();
  });

  test.afterAll(async () => {
    await sApp?.close();
    if (sBase) fs.rmSync(sBase, { recursive: true, force: true });
  });

  test('four files open at once, each in its own frame, by a double click in the tree, and the canvas gets no nodes', async () => {
    for (const name of NAMES) await sp.locator(`[data-tree-file="${name}"]`).dblclick();
    await expect(sp.locator('[data-surface]')).toHaveCount(4);
    for (const name of NAMES) await expect.poll(() => textIn(surface(name))).toBe(`content of ${name}\n`);
    await expect(sp.locator('.react-flow__node')).toHaveCount(0);
    await sp.locator('[data-tree-close]').click();
  });

  test('the canvas and its question box stay within reach with the documents open', async () => {
    // a point on the canvas that no frame covers belongs to the canvas, not to a layer over it
    const free = await sp.evaluate(() => {
      const dom = globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { closest(selector: string): unknown } | null } };
      const el = dom.document.elementFromPoint(120, 560);
      return { onCanvas: !!el?.closest('.react-flow'), inSurfaceLayer: !!el?.closest('[data-surface]') };
    });
    expect(free).toEqual({ onCanvas: true, inSurfaceLayer: false });

    // a double click there asks a question on the canvas, as it does with no documents open
    await sp.locator('.react-flow__pane').dblclick({ position: { x: 120, y: 560 } });
    await expect(sp.locator('.react-flow__node')).toHaveCount(1);
    const question = sp.locator('.react-flow__node textarea').first();
    await question.click();
    await question.fill('What do these four files have in common?');
    await expect(question).toHaveValue('What do these four files have in common?');
    await expect(sp.locator('[data-surface]')).toHaveCount(4);
  });

  test('switching quickly between the documents sends each keystroke to the one in front, and none of it to the canvas', async () => {
    for (const name of ['two.tex', 'four.txt', 'one.md', 'three.py', 'two.tex']) {
      await bringForward(name);
      const box = surface(name).locator('.cm-content');
      await box.click();
      await sp.keyboard.press('ControlOrMeta+Home');
      await sp.keyboard.press('End');
      await sp.keyboard.type(' r ');
      await sp.keyboard.press('Delete');
      await sp.keyboard.press('Backspace');
    }
    expect(await textIn(surface('two.tex'))).toMatch(/ r r/);
    for (const name of NAMES) expect(await textIn(surface(name))).toMatch(new RegExp(`^content of ${name.replace('.', '\\.')}`));
    // the question on the canvas is still there, untouched: neither deleted nor run again nor collapsed
    await expect(sp.locator('.react-flow__node')).toHaveCount(1);
    await expect(sp.locator('.react-flow__node textarea').first()).toHaveValue('What do these four files have in common?');
  });

  test('a frame is moved by its title bar, resized from its corner, and never smaller than its smallest size', async () => {
    await bringForward('one.md');
    const before = await boxOf('one.md');
    const bar = (await surface('one.md').locator('[data-surface-titlebar]').boundingBox())!;
    await sp.mouse.move(bar.x + 60, bar.y + bar.height / 2);
    await sp.mouse.down();
    await sp.mouse.move(bar.x + 60 - 150, bar.y + bar.height / 2 + 90, { steps: 5 });
    await sp.mouse.up();
    const moved = await boxOf('one.md');
    expect(Math.round(moved.x - before.x)).toBe(-150);
    expect(Math.round(moved.y - before.y)).toBe(90);

    const grip = (await surface('one.md').locator('[data-surface-resize]').boundingBox())!;
    await sp.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await sp.mouse.down();
    await sp.mouse.move(grip.x - 2000, grip.y - 2000, { steps: 5 });
    await sp.mouse.up();
    const small = await boxOf('one.md');
    expect([Math.round(small.width), Math.round(small.height)]).toEqual([360, 240]);
    expect([Math.round(small.x), Math.round(small.y)]).toEqual([Math.round(moved.x), Math.round(moved.y)]);
  });

  test('a frame fills the canvas area and goes back, docks to a side, and is put away and brought back', async () => {
    await bringForward('two.tex');
    const before = await boxOf('two.tex');
    await surface('two.tex').locator('[data-surface-maximize]').click();
    const layer = (await sp.locator('[data-surface-layer]').boundingBox())!;
    const full = await boxOf('two.tex');
    expect([Math.round(full.width), Math.round(full.height)]).toEqual([Math.round(layer.width), Math.round(layer.height)]);
    await surface('two.tex').locator('[data-surface-maximize]').click();
    expect(await boxOf('two.tex')).toEqual(before);

    await bringForward('three.py');
    await surface('three.py').locator('[data-surface-dock-left]').click();
    const docked = await boxOf('three.py');
    expect([Math.round(docked.x - layer.x), Math.round(docked.height)]).toEqual([0, Math.round(layer.height)]);

    await bringForward('four.txt');
    await surface('four.txt').locator('[data-surface-minimize]').click();
    await expect(surface('four.txt')).toHaveCount(0);
    await expect(sp.locator('[data-surface-tray] [data-surface-chip]')).toHaveCount(1);
    await sp.locator('[data-surface-tray] [data-surface-chip]').click();
    await expect(surface('four.txt')).toBeVisible();
    await surface('four.txt').locator('[data-surface-minimize]').click();
  });

  test('a frame that the window shrinks away from is brought back to where its title bar can be reached', async () => {
    await sApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(900, 620); });
    await expect.poll(async () => (await sp.locator('[data-surface-layer]').boundingBox())!.width).toBeLessThan(950);
    const layer = (await sp.locator('[data-surface-layer]').boundingBox())!;
    for (const name of ['one.md', 'two.tex']) {
      const bar = (await surface(name).locator('[data-surface-titlebar]').boundingBox())!;
      expect(bar.y, name).toBeGreaterThanOrEqual(layer.y);
      expect(bar.y + bar.height, name).toBeLessThanOrEqual(layer.y + layer.height);
      expect(layer.x + layer.width - (await boxOf(name)).x, name).toBeGreaterThanOrEqual(96);
    }
    await sApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1500, 950); });
  });

  test('the documents are where they were after the page is loaded again: floating, docked and put away', async () => {
    await sp.waitForTimeout(600);
    await sp.reload();
    await expect(sp.locator('[data-surface]')).toHaveCount(3);
    await expect(surface('three.py')).toHaveAttribute('data-surface-placement', 'left');
    await expect(sp.locator('[data-surface-tray] [data-surface-chip]')).toHaveCount(1);
    await expect.poll(() => textIn(surface('two.tex'))).toMatch(/^content of two\.tex/);
  });

  test('closing a document\'s view deletes nothing', async () => {
    for (const name of ['one.md', 'two.tex', 'three.py']) { await bringForward(name); await surface(name).locator('[data-surface-close]').click(); }
    await expect(sp.locator('[data-surface]')).toHaveCount(0);
    expect(fs.readdirSync(sProject).filter((n) => !n.startsWith('.')).sort()).toEqual([...NAMES].sort());
  });
});

test.describe.serial('editors and readers, in the desktop shell', () => {
  let eBase: string;
  let eProject: string;
  let eApp: ElectronApplication;
  let ep: Page;
  const disk = (name: string) => path.join(eProject, name);
  const surface = (name: string) => surfaceOn(ep, name);
  const openFromTree = (name: string) => ep.locator(`[data-tree-file="${name}"]`).dblclick();
  /** What ran in the page that should not have: a script in a file sets one of these if it is ever run. */
  const ranInPage = () => ep.evaluate(() => { const w = globalThis as unknown as Record<string, unknown>; return [w.__ranFromHtml, w.__ranFromMarkdown].filter((v) => v !== undefined).length; });

  test.beforeAll(async () => {
    eBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-editors-')));
    eProject = path.join(eBase, 'research-project');
    fs.mkdirSync(eProject, { recursive: true });
    fs.writeFileSync(disk('notes.md'), '# Notes\n\nSome **bold** words.\n\n<script>window.__ranFromMarkdown = true</script>\n');
    fs.writeFileSync(disk('paper.tex'), '\\section{Method}\n');
    fs.writeFileSync(disk('analysis.py'), 'def mean(xs):\n    return sum(xs) / len(xs)\n');
    fs.writeFileSync(disk('paper.pdf'), pdfWithPages(['PDF_PAGE_ONE_TEXT', 'PDF_PAGE_TWO_TEXT']));
    fs.writeFileSync(disk('draft.docx'), docxWith(['DOCX_FIRST_PARAGRAPH', 'DOCX_SECOND_PARAGRAPH']));
    fs.writeFileSync(disk('pixel.png'), onePixelPng());
    fs.writeFileSync(disk('page.html'), '<html><body><h1>HTML_SHOWN_TEXT</h1><script>top.__ranFromHtml = true; window.__ranFromHtml = true</script><p onclick="top.__ranFromHtml = true">text</p></body></html>');
    fs.writeFileSync(disk('huge.csv'), Buffer.alloc(8 * 1024 * 1024 + 1, 'a'));
    eApp = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(eBase, 'profile')}`],
      cwd: REPO,
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await eApp.evaluate(({ dialog, shell }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
      const shown: string[] = [];
      (globalThis as unknown as { __shown: string[] }).__shown = shown;
      shell.showItemInFolder = (target: string) => { shown.push(target); };
    }, eProject);
    ep = await eApp.firstWindow();
    await ep.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });
    await markLessonSeen(ep);
    await ep.reload();
    await ep.locator('[data-workspace-toggle]').click();
    await ep.locator('[data-open-folder]').click();
    await expect(ep.locator('[data-tree-file="paper.pdf"]')).toBeVisible();
  });

  test.afterAll(async () => {
    await eApp?.close();
    if (eBase) fs.rmSync(eBase, { recursive: true, force: true });
  });

  test('Markdown, LaTeX and Python are typed into side by side while a PDF is open to read, and each lands in its own file', async () => {
    for (const name of ['notes.md', 'paper.tex', 'analysis.py', 'paper.pdf']) await openFromTree(name);
    await ep.locator('[data-tree-close]').click();
    await expect(ep.locator('[data-surface]')).toHaveCount(4);
    await expect(surface('paper.pdf').locator('[data-reader="pdf"]')).toBeVisible();

    await surface('analysis.py').locator('[data-surface-dock-left]').click();
    await typeIn(surface('analysis.py'), 'def median(xs):\nreturn sorted(xs)[len(xs) // 2]\n');
    await expect(surface('analysis.py').locator('[data-surface-state]')).toHaveAttribute('data-surface-state', 'clean');
    // the editor knows the language: the line after a block opener is indented for the person
    expect(fs.readFileSync(disk('analysis.py'), 'utf8')).toBe('def median(xs):\n    return sorted(xs)[len(xs) // 2]\n');

    await surface('paper.tex').locator('[data-surface-minimize]').click();
    await ep.locator('[data-surface-tray] [data-surface-chip]').click();
    await typeIn(surface('paper.tex'), '\\section{Results}\n');
    await expect(surface('paper.tex').locator('[data-surface-state]')).toHaveAttribute('data-surface-state', 'clean');
    expect(fs.readFileSync(disk('paper.tex'), 'utf8')).toBe('\\section{Results}\n');
    await surface('paper.tex').locator('[data-surface-close]').click();
    await surface('analysis.py').locator('[data-surface-close]').click();
  });

  test('a Markdown file reads as it is typed, and markup in it is shown and never run', async () => {
    const md = surface('notes.md');
    await md.locator('[data-surface-maximize]').click();
    await md.locator('[data-markdown-mode="split"]').click();
    const preview = md.locator('[data-markdown-preview]');
    await expect(preview.locator('h1')).toHaveText('Notes');
    await expect(preview.locator('strong')).toHaveText('bold');
    await expect(preview.locator('script')).toHaveCount(0);
    await md.locator('.cm-content').click();
    await ep.keyboard.press('ControlOrMeta+End');
    await ep.keyboard.insertText('## TYPED_HEADING_Q6');
    await expect(preview.locator('h2')).toHaveText('TYPED_HEADING_Q6');
    await expect(md.locator('[data-surface-state]')).toHaveAttribute('data-surface-state', 'clean');
    expect(fs.readFileSync(disk('notes.md'), 'utf8')).toContain('## TYPED_HEADING_Q6');
    expect(await ranInPage()).toBe(0);
    await md.locator('[data-surface-close]').click();
  });

  test('a PDF is read page by page with its words selectable, and a quote from it lands on the canvas with its page', async () => {
    const pdf = surface('paper.pdf');
    await pdf.locator('[data-surface-maximize]').click();
    await expect(pdf.locator('[data-page]')).toHaveCount(2);
    await expect(pdf.locator('[data-page="2"] .tdag-textlayer')).toContainText('PDF_PAGE_TWO_TEXT');
    // the person selects the words on the second page
    await pdf.locator('[data-page="2"]').scrollIntoViewIfNeeded();
    await ep.evaluate(() => {
      type Node = { textContent: string | null };
      const dom = globalThis as unknown as { document: { querySelector(s: string): { querySelectorAll(s: string): Iterable<Node> } | null; createRange(): { selectNodeContents(n: Node): void } }; getSelection(): { removeAllRanges(): void; addRange(r: unknown): void } };
      const span = [...dom.document.querySelector('[data-page="2"] .tdag-textlayer')!.querySelectorAll('span')].find((n) => (n.textContent ?? '').includes('PDF_PAGE_TWO_TEXT'))!;
      const range = dom.document.createRange();
      range.selectNodeContents(span);
      const selection = dom.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await pdf.locator('[data-reader-quote]').click();
    await pdf.locator('[data-surface-close]').click();
    const note = ep.locator('.react-flow__node').filter({ hasText: 'PDF_PAGE_TWO_TEXT' });
    await expect(note).toHaveCount(1);
    await expect(note).toContainText('paper.pdf p.2');
    await expect(ep.locator('.react-flow__edge')).toHaveCount(0);
  });

  test('a Word document shows the text taken out of it and says so; the file itself is not changed and is not typed into', async () => {
    const before = fs.readFileSync(disk('draft.docx'));
    await ep.locator('[data-workspace-toggle]').click();
    await openFromTree('draft.docx');
    const docx = surface('draft.docx');
    await expect(docx.locator('[data-reader-derived]')).toBeVisible();
    await expect(docx.locator('[data-reader-text]')).toContainText('DOCX_FIRST_PARAGRAPH');
    await expect(docx.locator('[data-reader-text]')).toContainText('DOCX_SECOND_PARAGRAPH');
    await expect(docx.locator('.cm-editor')).toHaveCount(0);
    await expect(docx.locator('[data-surface-save]')).toHaveCount(0);
    await docx.locator('[data-surface-close]').click();
    expect(fs.readFileSync(disk('draft.docx')).equals(before)).toBe(true);
  });

  test('an image is shown, and an HTML page is shown without any of its scripts running', async () => {
    await openFromTree('pixel.png');
    await expect(surface('pixel.png').locator('[data-reader-image]')).toBeVisible();
    await surface('pixel.png').locator('[data-surface-close]').click();

    await openFromTree('page.html');
    const html = surface('page.html');
    const frame = html.locator('iframe').first();
    await expect(frame).toBeVisible();
    expect(await frame.getAttribute('sandbox') ?? '').not.toContain('allow-scripts');
    await expect(html.frameLocator('iframe').first().locator('h1')).toHaveText('HTML_SHOWN_TEXT');
    await ep.waitForTimeout(300);
    expect(await ranInPage()).toBe(0);
    await html.locator('[data-surface-close]').click();
  });

  test('a text file above the limit is not opened to type into: the surface says so and offers to show the file', async () => {
    await openFromTree('huge.csv');
    const huge = surface('huge.csv');
    await expect(huge.locator('[data-surface-notice="too-large"]')).toBeVisible();
    await expect(huge.locator('.cm-editor')).toHaveCount(0);
    await huge.locator('[data-surface-reveal]').click();
    await expect.poll(() => eApp.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown)).toEqual([disk('huge.csv')]);
    expect(fs.statSync(disk('huge.csv')).size).toBe(8 * 1024 * 1024 + 1);
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

    // the file opened as it was made: it is typed into right away
    const surface = surfaceOn(freshPage, 'Untitled-001.md');
    await typeIn(surface, 'FIRST_WORDS_Y3\n');
    await surface.locator('[data-surface-save]').click();
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
