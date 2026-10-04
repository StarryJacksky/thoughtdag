import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// File operations and change events in the real desktop shell: preload
// bridge, IPC, the service, the real folder watcher. A throwaway profile and
// a synthetic project folder; the system folder picker answers with that
// folder, and the system trash is switched off so nothing lands in the
// person's real Trash.

const REPO = path.resolve(import.meta.dirname, '..', '..');
const electronBinary = createRequire(import.meta.url)(path.join(REPO, 'desktop', 'node_modules', 'electron')) as string;

let base: string;
let project: string;
let app: ElectronApplication;
let page: Page;
let workspaceId: string;

type Settled<T> = { ok: true; value: T } | { ok: false; message: string };
const settle = <T>(expression: string) => page.evaluate(`(async () => { try { return { ok: true, value: await (${expression}) }; } catch (e) { return { ok: false, message: String(e && e.message) }; } })()`) as Promise<Settled<T>>;
const json = (value: unknown) => JSON.stringify(value);
/** Call a bridge method and return its value; a refusal fails the test with its message. */
async function door<T>(method: string, ...args: unknown[]): Promise<T> {
  const result = await settle<T>(`window.desktopWorkspace.${method}(${args.map(json).join(', ')})`);
  if (!result.ok) throw new Error(`${method}: ${result.message}`);
  return result.value;
}
interface Record { fileId: string; relativePath: string; origin: string; revision: string | null; status: string; importedFrom?: { source: string; note?: string } }
interface Event { fileId: string; change: string; opId: string | null; observedRevision: string | null }
const events = () => page.evaluate('window.__workspaceEvents') as Promise<Event[]>;

test.describe.serial('files in a workspace, through the desktop shell', () => {
  test.beforeAll(async () => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-desktop-files-')));
    project = path.join(base, 'research-project');
    fs.mkdirSync(path.join(project, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(project, 'notes', 'a.md'), 'FIRST_TEXT_B3\n');

    app = await electron.launch({
      executablePath: electronBinary,
      args: [path.join(REPO, 'desktop'), `--user-data-dir=${path.join(base, 'profile')}`],
      cwd: REPO,
      env: { ...process.env, TD_SESSION_ROOTS: '{}' },
    });
    await app.evaluate(({ dialog, shell }, dir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
      shell.trashItem = async () => { throw new Error('the system trash is off in tests'); };
    }, project);
    page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 60_000 });

    workspaceId = (await door<{ workspaceId: string }>('chooseRoot')).workspaceId;
    await page.evaluate('window.__workspaceEvents = []; window.desktopWorkspace.onEvent((e) => window.__workspaceEvents.push(e));');
    await door('subscribe', workspaceId);
  });

  test.afterAll(async () => {
    await app?.close();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  test('a file created from the graph lands in Graph Files on disk, once per request', async () => {
    const request = { workspaceId, extension: 'md', origin: 'graph', idempotencyKey: 'op-create-1' };
    const record = await door<Record>('createFile', request);
    expect(record).toMatchObject({ relativePath: 'Graph Files/Untitled-001.md', origin: 'graph', status: 'ready' });
    expect((await door<Record>('createFile', request)).fileId).toBe(record.fileId);
    expect(fs.readdirSync(path.join(project, 'Graph Files'))).toEqual(['Untitled-001.md']);
  });

  test('a save through the bridge lands on disk and is announced with its operation id', async () => {
    const entries = await door<{ name: string; entryId: string }[]>('listChildren', workspaceId, 'e_' + Buffer.from('notes').toString('base64url'));
    const record = await door<Record>('registerEntry', workspaceId, entries.find((e) => e.name === 'a.md')!.entryId);
    const read = await door<{ text: string; revision: string }>('readText', record.fileId);
    expect(read.text).toBe('FIRST_TEXT_B3\n');
    const saved = await door<{ status: string; revision: string }>('saveText', record.fileId, read.revision, 'SECOND_TEXT_D5\n', 'op-save-1');
    expect(saved.status).toBe('saved');
    expect(fs.readFileSync(path.join(project, 'notes', 'a.md'), 'utf8')).toBe('SECOND_TEXT_D5\n');
    await expect.poll(async () => (await events()).filter((e) => e.fileId === record.fileId).map((e) => [e.change, e.opId])).toEqual([['content', 'op-save-1']]);

    // the revision that was read is stale now: a second save from it is a conflict, not an overwrite
    const stale = await door<{ status: string }>('saveText', record.fileId, read.revision, 'THIRD\n', 'op-save-2');
    expect(stale.status).toBe('conflict');
    expect(fs.readFileSync(path.join(project, 'notes', 'a.md'), 'utf8')).toBe('SECOND_TEXT_D5\n');
  });

  test('an edit by another program reaches the page through the real watcher, with no operation id', async () => {
    const before = (await events()).length;
    fs.writeFileSync(path.join(project, 'notes', 'a.md'), 'EXTERNAL_EDIT_E6\n');
    await expect.poll(async () => (await events()).length, { timeout: 10_000 }).toBeGreaterThan(before);
    const latest = (await events()).at(-1)!;
    expect([latest.change, latest.opId]).toEqual(['content', null]);
  });

  test('imported text becomes a local file marked as a copy', async () => {
    const record = await door<Record>('importText',
      { workspaceId, extension: 'md', origin: 'workspace', idempotencyKey: 'op-import-1' },
      { text: '# Reading notes\n\nIMPORTED_COPY_M8\n', name: 'Reading notes', provenance: { source: 'chatgpt-space', note: 'Reading notes (Lab space)' } });
    expect(record).toMatchObject({ relativePath: 'Reading notes.md', origin: 'import', importedFrom: { source: 'chatgpt-space', note: 'Reading notes (Lab space)' } });
    expect(fs.readFileSync(path.join(project, 'Reading notes.md'), 'utf8')).toContain('IMPORTED_COPY_M8');
  });

  test('a move keeps the identity, and a trashed file is kept, not destroyed', async () => {
    const created = await door<Record>('createFile', { workspaceId, extension: 'txt', origin: 'workspace', idempotencyKey: 'op-create-2' });
    const notes = 'e_' + Buffer.from('notes').toString('base64url');
    const moved = await door<Record>('moveFile', created.fileId, notes, 'moved.txt', 'op-move-1');
    expect([moved.fileId, moved.relativePath]).toEqual([created.fileId, 'notes/moved.txt']);
    expect(fs.existsSync(path.join(project, 'notes', 'moved.txt'))).toBe(true);

    const receipt = await door<{ receiptId: string; location: string; restorable: boolean }>('trashFile', created.fileId, 'op-trash-1');
    expect([receipt.location, receipt.restorable]).toEqual(['project-recovery', true]);
    expect(fs.existsSync(path.join(project, 'notes', 'moved.txt'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.thoughtdag', 'recovery', 'trash', receipt.receiptId, 'moved.txt'))).toBe(true);
  });

  test('a request the contract does not allow is refused by the shell, with no path in the message', async () => {
    const result = await settle(`window.desktopWorkspace.createFile(${json({ workspaceId, extension: 'md', origin: 'graph', idempotencyKey: 'op-bad-1', path: '/etc/passwd' })})`);
    expect(result.ok).toBe(false);
    const message = (result as { message: string }).message;
    expect(message).toContain('invalid-request: ');
    expect(message).not.toContain(base);
  });
});
