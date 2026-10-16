// What a run leaves in a workspace whose files it read: its record, at
// <root>/.thoughtdag/runs/<runId>/record.json, apart from the snapshots it
// names (snapshots.cjs). A record says what the run was given (its inputs
// and the snapshots that hold them), what it was sent as (the digests), what
// it was sent to, where its answer went and how it ended. It is written
// whole or not at all: beside its place, flushed, then put in place in one
// step; how a run ended replaces how it began.
//
// After a crash the records and the snapshots are checked against each
// other: a snapshot a record names and that is gone, or whose bytes no
// longer hash to its name, is said to be so; a run whose record never said
// how it ended is unknown, not ended. Cleaning up removes only snapshots no
// record names, and only those older than a grace period, so that a run
// that has frozen its files and not yet recorded them does not lose them
// (a snapshot frozen again is new again). When any record cannot be read,
// nothing is removed: what it names cannot be known.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { METADATA_DIR, WorkspaceAccessError } = require('../workspace/path-policy.cjs');
const { parseSnapshotId, readSnapshot, snapshotRoot } = require('../workspace/snapshots.cjs');

const RUNS_DIR = 'runs';
const RECORD = 'record.json';
const RUN_ID = /^run_[A-Za-z0-9_-]{1,80}$/;
const INPUT_ID = /^in_[A-Za-z0-9_-]{1,64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
// a run's input is held in a snapshot here, in no snapshot (a read-only folder), or on the canvas
const HELD_IN = /^(snap_[0-9a-f]{64}|unkept:[0-9a-f]{64}|node:[0-9a-f]{64})$/;
const STATES = new Set(['prepared', 'starting', 'running', 'awaiting-approval', 'cancelling', 'completed', 'failed', 'cancelled', 'unknown']);
const ENDED = new Set(['completed', 'failed', 'cancelled']);
const MAX_INPUTS = 200;
const MAX_RECORD_BYTES = 256 * 1024;
/** How long a snapshot no record names is kept anyway: a run may have frozen it and not yet recorded it. */
const MIN_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const runsRoot = (rootPath) => path.join(rootPath, METADATA_DIR, RUNS_DIR);
const refuse = (message) => new WorkspaceAccessError('invalid-request', message);
const isText = (v, max = 512) => typeof v === 'string' && v.length <= max;

/** The record as it is to be written, or a refusal: nothing that is not a run record goes to disk. */
function checkRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw refuse('that is not a run record');
  if (record.schemaVersion !== '1') throw refuse('a run record of a version this shell does not write');
  if (!RUN_ID.test(String(record.runId))) throw refuse('a run record names its run by a run id');
  if (!STATES.has(record.state)) throw refuse('a run record says which state its run is in');
  for (const key of ['inputDigest', 'executionDigest']) if (!HASH.test(String(record[key]))) throw refuse(`a run record has its ${key}`);
  for (const key of ['graphId', 'taskNodeId', 'targetId', 'targetRevision']) if (!isText(record[key])) throw refuse(`a run record names its ${key}`);
  if (!Array.isArray(record.inputs) || record.inputs.length > MAX_INPUTS) throw refuse(`a run record lists at most ${MAX_INPUTS} inputs`);
  for (const input of record.inputs) {
    if (!input || typeof input !== 'object' || !INPUT_ID.test(String(input.inputId)) || !HELD_IN.test(String(input.snapshotId)) || !HASH.test(String(input.contentHash))) {
      throw refuse('an input of a run record is not one');
    }
    if (input.fileId !== undefined && !isText(input.fileId, 128)) throw refuse('an input of a run record names its file by an id');
  }
  if (record.output !== null && (typeof record.output !== 'object' || !Number.isInteger(record.output.versionIndex) || record.output.versionIndex < 0)) {
    throw refuse('a run record says which answer version it wrote, or none');
  }
  return record;
}

/** Write a run's record, whole, in place of any record of the same run. */
async function writeRecord(rootPath, record, io = fs.promises) {
  checkRecord(record);
  const text = JSON.stringify(record, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw refuse('a run record is at most 256 KiB');
  const dir = path.join(runsRoot(rootPath), record.runId);
  await io.mkdir(dir, { recursive: true });
  const target = path.join(dir, RECORD);
  const temp = path.join(dir, `.${RECORD}.tdag-${randomUUID().slice(0, 8)}`);
  try {
    const handle = await io.open(temp, 'wx');
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await io.rename(temp, target);
  } catch (e) {
    await io.rm(temp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Every record of the workspace, and the runs whose record cannot be read as one. */
async function readRecords(rootPath, io = fs.promises) {
  const names = (await io.readdir(runsRoot(rootPath)).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })).filter((n) => RUN_ID.test(n)).sort();
  const records = [];
  const unreadable = [];
  for (const runId of names) {
    let text;
    try { text = await io.readFile(path.join(runsRoot(rootPath), runId, RECORD), 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') continue; // a run directory with materials and no record: written by a run that read nothing here
      unreadable.push(runId);
      continue;
    }
    try {
      const record = checkRecord(JSON.parse(text));
      if (record.runId !== runId) throw refuse('a run record is under another run');
      records.push(record);
    } catch { unreadable.push(runId); }
  }
  return { records, unreadable };
}

/** What a record names that is held here: the snapshots of its inputs. */
const heldBy = (record) => record.inputs.map((i) => i.snapshotId).filter((id) => parseSnapshotId(id) !== null);

/**
 * The records checked against the snapshots, as after a crash: for each run, how it ended (or
 * `unknown` when its record never said), the snapshots it names that are gone, and those whose
 * bytes no longer hash to their names.
 */
async function reconcileRuns(rootPath, io = fs.promises) {
  const { records, unreadable } = await readRecords(rootPath, io);
  const runs = [];
  for (const record of records) {
    const missing = [];
    const damaged = [];
    for (const snapshotId of [...new Set(heldBy(record))]) {
      if (await readSnapshot(rootPath, snapshotId, io)) continue;
      const there = await io.stat(path.join(snapshotRoot(rootPath), parseSnapshotId(snapshotId))).then(() => true, () => false);
      (there ? damaged : missing).push(snapshotId);
    }
    runs.push({ runId: record.runId, state: ENDED.has(record.state) ? record.state : 'unknown', recorded: record.state, missing, damaged });
  }
  return { runs, unreadable };
}

/**
 * Remove the snapshots no record names that are older than `graceMs` (at least an hour). A
 * snapshot a record names is kept however old it is. Answers `{ removed, refused }`; `refused`
 * says why nothing was removed.
 */
async function collectSnapshots(rootPath, { graceMs = DEFAULT_GRACE_MS, now = Date.now() } = {}, io = fs.promises) {
  const { records, unreadable } = await readRecords(rootPath, io);
  if (unreadable.length > 0) return { removed: [], refused: 'unreadable-record' };
  const held = new Set(records.flatMap(heldBy));
  const grace = Math.max(MIN_GRACE_MS, Number.isFinite(graceMs) ? graceMs : DEFAULT_GRACE_MS);
  const dir = snapshotRoot(rootPath);
  const names = (await io.readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })).filter((n) => /^[0-9a-f]{64}$/.test(n)).sort();
  const removed = [];
  for (const hex of names) {
    if (held.has(`snap_${hex}`)) continue;
    const st = await io.stat(path.join(dir, hex)).catch(() => null);
    if (!st || now - st.mtimeMs <= grace) continue;
    await io.rm(path.join(dir, hex), { force: true });
    removed.push(`snap_${hex}`);
  }
  return { removed, refused: null };
}

module.exports = { writeRecord, readRecords, reconcileRuns, collectSnapshots, checkRecord, runsRoot, RECORD, MIN_GRACE_MS };
