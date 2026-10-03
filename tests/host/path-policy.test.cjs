// Where a workspace operation may land. Each case builds a small folder in a
// temp directory and asks the policy about one path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertAllowedPath, assertPortableName, WorkspaceAccessError } = require('../../runtime/workspace/path-policy.cjs');

const posix = process.platform !== 'win32';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-policy-')));
const root = path.join(base, 'workspace');
const outside = path.join(base, 'outside');
fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
fs.mkdirSync(path.join(root, '.thoughtdag'), { recursive: true });
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, 'notes', 'a.md'), 'INSIDE_NOTE_F2');
fs.writeFileSync(path.join(root, '.thoughtdag', 'resources.json'), '{}');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET_H4');
if (posix) {
  fs.symlinkSync(outside, path.join(root, 'out-link'));
  fs.symlinkSync(path.join(root, 'notes'), path.join(root, 'in-link'));
  fs.symlinkSync(path.join(root, 'notes', 'a.md'), path.join(root, 'file-link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'notes', 'leak.md'));
}
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const grant = { rootPath: root, readOnly: false };
const readOnly = { rootPath: root, readOnly: true };

/** The policy must refuse with this code, and say nothing of where the root is. */
async function refused(code, g, operation, relativePath) {
  await assert.rejects(assertAllowedPath(g, operation, relativePath), (e) => {
    assert.ok(e instanceof WorkspaceAccessError, `expected a WorkspaceAccessError, got ${e}`);
    assert.equal(e.code, code, `${operation} ${JSON.stringify(relativePath)}`);
    assert.ok(!e.message.includes(base), 'the message names an absolute path');
    return true;
  });
}

test('an ordinary file in a granted folder can be read, and resolves to its real place', async () => {
  const target = await assertAllowedPath(grant, 'read', 'notes/a.md');
  assert.deepEqual(target, { absolute: path.join(root, 'notes', 'a.md'), relativePath: 'notes/a.md', exists: true, kind: 'file' });
});

test('the root and its folders can be listed', async () => {
  assert.equal((await assertAllowedPath(grant, 'list', '')).kind, 'directory');
  assert.equal((await assertAllowedPath(grant, 'list', 'notes')).absolute, path.join(root, 'notes'));
});

test('either separator names the same place, stored with forward slashes', async () => {
  assert.equal((await assertAllowedPath(grant, 'read', 'notes\\a.md')).relativePath, 'notes/a.md');
  assert.equal((await assertAllowedPath(grant, 'read', 'notes//a.md')).relativePath, 'notes/a.md');
});

for (const p of ['../outside/secret.txt', 'notes/../../outside/secret.txt', 'notes/..', '..', 'notes/./a.md', 'notes\\..\\..\\outside']) {
  test(`a path that steps out of its directory is refused: ${p}`, () => refused('traversal', grant, 'read', p));
}

for (const p of ['/etc/passwd', '\\Windows\\system32', 'C:\\Windows\\system32', 'C:/Users', 'c:notes', '\\\\server\\share\\file.md', '//server/share/file.md']) {
  test(`an absolute path, a drive or a network share is refused: ${p}`, () => refused('absolute-path', grant, 'read', p));
}

test('a path with a NUL, or that is not a string, is refused', async () => {
  await refused('invalid-path', grant, 'read', 'notes/a.md\0.png');
  await refused('invalid-path', grant, 'read', ['notes', 'a.md']);
  await refused('invalid-path', grant, 'read', undefined);
});

test('the workspace\'s own records are not reachable as files, in any case', async () => {
  await refused('metadata-directory', grant, 'read', '.thoughtdag/resources.json');
  await refused('metadata-directory', grant, 'list', '.thoughtdag');
  await refused('metadata-directory', grant, 'write', '.THOUGHTDAG/resources.json');
  await refused('metadata-directory', grant, 'create', '.thoughtdag/new.json');
});

test('a link that leads out of the workspace is refused, for reading, listing and creating', { skip: !posix }, async () => {
  await refused('escapes-root', grant, 'read', 'out-link/secret.txt');
  await refused('escapes-root', grant, 'list', 'out-link');
  await refused('escapes-root', grant, 'create', 'out-link/new.md');
  await refused('escapes-root', grant, 'read', 'notes/leak.md');
});

test('a link that stays inside the workspace is followed to its real place', { skip: !posix }, async () => {
  assert.equal((await assertAllowedPath(grant, 'read', 'in-link/a.md')).absolute, path.join(root, 'notes', 'a.md'));
  assert.equal((await assertAllowedPath(grant, 'read', 'file-link')).absolute, path.join(root, 'notes', 'a.md'));
});

test('a change is never made through a link, even one that stays inside', { skip: !posix }, async () => {
  await refused('symbolic-link', grant, 'write', 'file-link');
  await refused('symbolic-link', grant, 'trash', 'in-link');
  await refused('symbolic-link', grant, 'move-from', 'file-link');
});

test('a read-only workspace allows reading and listing and refuses every change', async () => {
  assert.equal((await assertAllowedPath(readOnly, 'read', 'notes/a.md')).exists, true);
  assert.equal((await assertAllowedPath(readOnly, 'list', 'notes')).kind, 'directory');
  for (const operation of ['write', 'trash', 'move-from']) await refused('read-only', readOnly, operation, 'notes/a.md');
  for (const operation of ['create', 'move-to']) await refused('read-only', readOnly, operation, 'notes/new.md');
});

test('a new file may go in an existing folder; the answer says whether the name is taken', async () => {
  assert.deepEqual(await assertAllowedPath(grant, 'create', 'notes/new.md'), { absolute: path.join(root, 'notes', 'new.md'), relativePath: 'notes/new.md', exists: false, kind: null });
  assert.equal((await assertAllowedPath(grant, 'create', 'notes/a.md')).exists, true);
  assert.equal((await assertAllowedPath(grant, 'move-to', 'top-level.md')).absolute, path.join(root, 'top-level.md'));
});

test('a new file cannot go in a folder that does not exist, or inside a file', async () => {
  await refused('not-found', grant, 'create', 'no-such-folder/new.md');
  await refused('not-found', grant, 'create', 'a/b/c/new.md');
  await refused('not-a-directory', grant, 'create', 'notes/a.md/new.md');
});

for (const [name, code] of [['CON', 'reserved-name'], ['nul.txt', 'reserved-name'], ['Com1.md', 'reserved-name'], ['LPT9', 'reserved-name'],
  ['what?.md', 'invalid-name'], ['a:b.md', 'invalid-name'], ['pipe|.md', 'invalid-name'], ['tab\there.md', 'invalid-name'], ['trailing.', 'invalid-name'], ['trailing ', 'invalid-name']]) {
  test(`a name that would not survive another platform is refused when created: ${JSON.stringify(name)}`, async () => {
    await refused(code, grant, 'create', `notes/${name}`);
    await refused(code, grant, 'move-to', `notes/${name}`);
    assert.throws(() => assertPortableName(name), (e) => e.code === code);
  });
}

test('a file that already carries such a name can still be read where the platform allows it', { skip: !posix }, async () => {
  fs.writeFileSync(path.join(root, 'notes', 'a:b.md'), 'x');
  assert.equal((await assertAllowedPath(grant, 'read', 'notes/a:b.md')).kind, 'file');
});

test('only what exists can be read, written, moved or trashed', async () => {
  for (const operation of ['read', 'stat', 'list', 'write', 'move-from', 'trash']) await refused('not-found', grant, operation, 'notes/missing.md');
});

test('a folder is not read as a file, and a file is not listed', async () => {
  await refused('not-a-file', grant, 'read', 'notes');
  await refused('not-a-directory', grant, 'list', 'notes/a.md');
});

test('the root itself cannot be changed', async () => {
  for (const operation of ['write', 'trash', 'move-from', 'create', 'move-to']) await refused('invalid-path', grant, operation, '');
});

test('nothing is allowed without a grant, on a root that is gone, or for an operation nobody defined', async () => {
  await refused('no-grant', null, 'read', 'notes/a.md');
  await refused('no-grant', { rootPath: 'relative/root', readOnly: false }, 'read', 'notes/a.md');
  await refused('root-missing', { rootPath: path.join(base, 'gone'), readOnly: false }, 'read', 'notes/a.md');
  await refused('unknown-operation', grant, 'execute', 'notes/a.md');
});
