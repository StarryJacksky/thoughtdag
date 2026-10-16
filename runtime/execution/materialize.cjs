// What an agent is given on disk for one run, written from the run's
// envelope and from nothing else. Each input goes under a name of its own
// (its input id, then a name safe to show), so two files of one name are two
// files; a passage selected is written as the passage, never the whole file;
// the bytes of a file are read back from the snapshot the run names and must
// hash to what was frozen, and what the canvas holds must hash to what the
// envelope says of it. Everything is read and checked before anything is
// written: a run that cannot be given what it was prepared with gets
// nothing on disk. What the person left out is not in the envelope's inputs,
// so it is never read here at all.
//
// The run directory holds `materials/`, with one file per input and
// `manifest.json`, the map of them. The files are written read-only.
'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

/** What one run may be given on disk in all. One file read for a run is at most 8 MiB. */
const MAX_MATERIAL_BYTES = 64 * 1024 * 1024;
const MAX_INPUTS = 200;
const RUN_ID = /^run_[A-Za-z0-9_-]{1,80}$/;
const INPUT_ID = /^in_[A-Za-z0-9_-]{1,64}$/;
const SNAPSHOT_ID = /^snap_[0-9a-f]{64}$/;
const UNKEPT_ID = /^unkept:[0-9a-f]{64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const MANIFEST = 'materials/manifest.json';
const RECORD = 'record.json';

class MaterializeError extends Error {
  constructor(code, message, inputId = null) {
    super(message);
    this.name = 'MaterializeError';
    this.code = code;
    this.inputId = inputId;
  }
}

const sha256 = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/**
 * Where a passage stands in a text, found by its words: the quote with the
 * words around it, else the quote alone. Two places that fit equally are an
 * ambiguity. The same rule as the page's (src/lib/context/resource-resolver.ts).
 */
function locatePassage(text, { quote, prefix = '', suffix = '' }) {
  if (!quote) return 'lost';
  const all = [];
  for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) all.push(at);
  if (all.length === 0) return 'lost';
  const inContext = all.filter((at) => text.slice(0, at).endsWith(prefix) && text.slice(at + quote.length).startsWith(suffix));
  const fits = inContext.length > 0 ? inContext : all;
  if (fits.length > 1) return 'ambiguous';
  return { from: fits[0], to: fits[0] + quote.length };
}

/** The last part of whatever a name says, with nothing a path could be made of. */
function safeName(displayName) {
  const last = String(displayName ?? '').split(/[\\/]/).pop() ?? '';
  let name = last.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, '_').replace(/^[.\s]+/, '').trim();
  if (name.length > 100) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, 100 - ext.length) + ext;
  }
  return name || 'input';
}

/** `in_x-notes.md`, or `in_x-notes.excerpt.md` for a passage of it. */
function fileNameOf(inputId, displayName, part) {
  const name = safeName(displayName);
  if (part !== 'passage') return `${inputId}-${name}`;
  const ext = path.extname(name);
  return `${inputId}-${ext ? name.slice(0, -ext.length) : name}.excerpt${ext || '.txt'}`;
}

function checkEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || !RUN_ID.test(String(envelope.runId)) || !Array.isArray(envelope.inputs)) {
    throw new MaterializeError('invalid-envelope', 'that is not a run envelope');
  }
  if (envelope.inputs.length > MAX_INPUTS) throw new MaterializeError('too-large', `a run is given at most ${MAX_INPUTS} inputs`);
  const seen = new Set();
  for (const input of envelope.inputs) {
    if (!input || typeof input !== 'object' || !INPUT_ID.test(String(input.inputId)) || !HASH.test(String(input.contentHash)) || seen.has(input.inputId)) {
      throw new MaterializeError('invalid-envelope', 'an input of the envelope is not one', input && typeof input.inputId === 'string' ? input.inputId : null);
    }
    seen.add(input.inputId);
  }
}

/** The bytes an input was frozen as: from its snapshot, from its read-only file as it is, or as the canvas gave them. */
async function frozenBytesOf(input, { readSnapshotOfFile, readCurrentOfFile, provided }) {
  const fail = (code, message) => new MaterializeError(code, message, input.inputId);
  const source = input.source;
  let bytes;
  if (source && source.kind === 'resource' && source.ref && typeof source.ref.fileId === 'string') {
    if (SNAPSHOT_ID.test(String(input.snapshotId))) {
      if (!readSnapshotOfFile) throw fail('unavailable', 'the files of a workspace cannot be read here');
      bytes = await readSnapshotOfFile(source.ref.fileId, input.snapshotId).catch(() => null);
      if (!bytes) throw fail('lost', 'the snapshot the run names is not kept');
    } else if (UNKEPT_ID.test(String(input.snapshotId))) {
      // a file in a folder opened read-only was not kept: it is given as it is, if it still is what was frozen
      if (!readCurrentOfFile) throw fail('unavailable', 'the files of a workspace cannot be read here');
      bytes = await readCurrentOfFile(source.ref.fileId).catch(() => null);
      if (!bytes) throw fail('lost', 'the file is lost');
    } else {
      throw fail('invalid-envelope', 'the input names no snapshot');
    }
  } else if (source && source.kind === 'attachment') {
    const given = provided && Object.prototype.hasOwnProperty.call(provided, input.inputId) ? provided[input.inputId] : null;
    if (typeof given !== 'string') throw fail('unavailable', 'what the canvas holds of this input was not given');
    bytes = Buffer.from(given, 'base64');
  } else {
    throw fail('invalid-envelope', 'the input says nothing of where it is from');
  }
  bytes = Buffer.from(bytes);
  if (sha256(bytes) !== input.contentHash) throw fail('hash-mismatch', 'the bytes are not what was frozen for the run');
  return bytes;
}

/** What of the frozen bytes the run is given: the whole, or the passage its selector names. */
function partOf(input, bytes) {
  const fail = (code, message) => new MaterializeError(code, message, input.inputId);
  const selector = input.source.kind === 'resource' ? input.source.ref.selector : { kind: 'document' };
  if (!selector || selector.kind === 'document') return { part: 'whole', bytes };
  if (selector.kind === 'text') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw fail('selection-lost', 'a passage was selected in a file that is not text'); }
    const at = locatePassage(text, selector);
    if (at === 'ambiguous') throw fail('selection-ambiguous', 'the passage stands more than once in the file');
    if (at === 'lost') throw fail('selection-lost', 'the passage is not in the file');
    return { part: 'passage', bytes: Buffer.from(text.slice(at.from, at.to), 'utf8') };
  }
  // pages of a PDF, nodes of a mind map: given as a part only once the part can be cut out here
  throw fail('unsupported-selector', `a ${selector.kind} selection cannot be written as a part yet`);
}

/**
 * Write a run's inputs into `runDirectory` (absent or empty). `readSnapshotOfFile(fileId,
 * snapshotId)` and `readCurrentOfFile(fileId)` read the workspace's files; `provided` holds
 * what the canvas holds, by input id, in base64. Resolves with the receipt; rejects with a
 * MaterializeError (`code`) and nothing written.
 */
async function materialize(envelope, runDirectory, { readSnapshotOfFile = null, readCurrentOfFile = null, provided = {}, maxBytes = MAX_MATERIAL_BYTES } = {}) {
  checkEnvelope(envelope);
  if (typeof runDirectory !== 'string' || !path.isAbsolute(runDirectory)) throw new MaterializeError('invalid-request', 'the run directory must be an absolute path');
  // the run's own record may be there already (run-records.cjs, in a workspace that is also the working directory)
  const present = await fsp.readdir(runDirectory).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
  if (present.some((n) => n !== RECORD)) throw new MaterializeError('not-empty', 'the run directory already holds something');

  // everything read and checked first: nothing is written unless all of it can be
  const planned = [];
  let total = 0;
  for (const input of envelope.inputs) {
    const frozen = await frozenBytesOf(input, { readSnapshotOfFile, readCurrentOfFile, provided });
    const { part, bytes } = partOf(input, frozen);
    total += bytes.length;
    if (total > maxBytes) throw new MaterializeError('too-large', `the inputs of the run come to more than ${maxBytes} bytes`, input.inputId);
    planned.push({ input, part, bytes, sourceHash: input.contentHash, writtenHash: sha256(bytes), file: fileNameOf(input.inputId, input.displayName, part) });
  }

  const dir = path.join(runDirectory, 'materials');
  await fsp.mkdir(dir, { recursive: true });
  const entries = planned.map((p) => ({
    inputId: p.input.inputId,
    path: `materials/${p.file}`,
    displayName: String(p.input.displayName ?? ''),
    part: p.part,
    bytes: p.bytes.length,
    sourceHash: p.sourceHash,
    writtenHash: p.writtenHash,
    permission: 'read',
  }));
  try {
    for (const p of planned) await fsp.writeFile(path.join(dir, p.file), p.bytes, { flag: 'wx', mode: 0o444 });
    const manifest = {
      schemaVersion: '1',
      runId: envelope.runId,
      inputs: entries.map((e) => ({ inputId: e.inputId, path: e.path, displayName: e.displayName, part: e.part, bytes: e.bytes, contentHash: e.sourceHash, writtenHash: e.writtenHash, permission: e.permission })),
    };
    await fsp.writeFile(path.join(runDirectory, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  } catch (e) {
    // the directory was empty and all of this is the run's own: none of it is left half written
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return { runId: envelope.runId, manifest: MANIFEST, entries, totalBytes: total };
}

/**
 * Remove the materials of the oldest runs under `runsRoot` beyond the newest `keep`. Materials
 * are removed only when they are exactly what their manifest lists: ones anything else wrote
 * into are left alone. A run's record stays; a run directory left empty goes.
 */
async function pruneRuns(runsRoot, { keep = 20 } = {}) {
  const names = (await fsp.readdir(runsRoot).catch(() => [])).filter((n) => RUN_ID.test(n));
  const dated = [];
  for (const name of names) {
    const st = await fsp.stat(path.join(runsRoot, name, 'materials')).catch(() => null);
    if (st && st.isDirectory()) dated.push({ name, at: st.mtimeMs });
  }
  dated.sort((a, b) => b.at - a.at);
  const removed = [];
  for (const { name } of dated.slice(keep)) {
    const dir = path.join(runsRoot, name);
    try {
      const top = await fsp.readdir(dir);
      if (top.some((n) => n !== 'materials' && n !== RECORD)) continue;
      const manifest = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8'));
      const listed = new Set(['manifest.json', ...manifest.inputs.map((i) => String(i.path).replace(/^materials\//, ''))]);
      const held = await fsp.readdir(path.join(dir, 'materials'));
      if (held.length !== listed.size || held.some((n) => !listed.has(n))) continue;
      await fsp.rm(path.join(dir, 'materials'), { recursive: true, force: true });
      if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
      removed.push(name);
    } catch { /* not a run directory as this module writes them: left alone */ }
  }
  return removed;
}

module.exports = { materialize, pruneRuns, locatePassage, safeName, MaterializeError, MAX_MATERIAL_BYTES, MANIFEST };
