// Recovery drafts: text a person typed into a file that has not been
// written to the file. A draft is kept in the workspace's own records
// (<root>/.thoughtdag/drafts), one per file, replaced whole each time. It
// is what survives a crash, a closed view, or a save that was refused; it
// is not the file, it never replaces the file by itself, and nothing here
// is ever chosen as model input.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { METADATA_DIR, WorkspaceAccessError } = require('./path-policy.cjs');

const DRAFTS_DIR = 'drafts';
/** A draft is text someone typed: the same limit as a file opened for editing. */
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;

const draftsRoot = (rootPath) => path.join(rootPath, METADATA_DIR, DRAFTS_DIR);
// a file id is made by this application, but it names a file on disk here: it is checked, not trusted
const draftFile = (rootPath, fileId) => {
  if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fileId)) throw new WorkspaceAccessError('invalid-request', 'that is not a file id');
  return path.join(draftsRoot(rootPath), `${fileId}.json`);
};

/** Keep `draft` ({ fileId, text, baseRevision, savedAt }) as the one draft of its file. Resolves when it is on disk whole. */
async function putDraft(rootPath, draft, io = fs.promises) {
  if (typeof draft?.text !== 'string') throw new WorkspaceAccessError('invalid-request', 'a draft is text');
  if (Buffer.byteLength(draft.text, 'utf8') > MAX_DRAFT_BYTES) throw new WorkspaceAccessError('too-large', 'the draft is too large to keep');
  const file = draftFile(rootPath, draft.fileId);
  await io.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tdag-draft-${randomUUID().slice(0, 8)}`;
  try {
    const handle = await io.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(draft)); await handle.sync(); } finally { await handle.close(); }
    await io.rename(temp, file);
  } catch (e) {
    await io.rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}

/** The draft kept for a file, or null. A draft that cannot be read as one is treated as none: it is left where it is. */
async function getDraft(rootPath, fileId, io = fs.promises) {
  let text;
  try { text = await io.readFile(draftFile(rootPath, fileId), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const draft = JSON.parse(text);
    return draft && draft.fileId === fileId && typeof draft.text === 'string' && typeof draft.baseRevision === 'string' && typeof draft.savedAt === 'string'
      ? { fileId, text: draft.text, baseRevision: draft.baseRevision, savedAt: draft.savedAt }
      : null;
  } catch { return null; }
}

/** Forget a file's draft: its text is in the file now, or the person let it go. */
async function clearDraft(rootPath, fileId, io = fs.promises) {
  await io.rm(draftFile(rootPath, fileId), { force: true });
}

module.exports = { putDraft, getDraft, clearDraft, draftsRoot, DRAFTS_DIR, MAX_DRAFT_BYTES };
