// R11-01 of the review of c440c81: a backup that waited for its folder before
// joining the queue of its target, so a later "back up now" could overtake an
// older automatic backup and the older bytes ended up on disk. Backups are
// written to a real temp folder; folder creation and writing are held or made
// to fail under node:fs/promises, which the module reads when it is required.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const errno = (code) => Object.assign(new Error(`${code}: injected`), { code });
const soon = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const real = { mkdir: fsp.mkdir, open: fsp.open };
/** What the next folder creations do, in order: 'pass', 'fail', or a gate to wait at. */
let mkdirPlan = [];
let mkdirs = 0;
/** A write held at the gate: the first write whose bytes `matches` waits until it is let through. */
let writeGate = null;

function gate() {
  let reach = () => {};
  let release = () => {};
  const reached = new Promise((resolve) => { reach = resolve; });
  const passage = new Promise((resolve) => { release = resolve; });
  return { reach, reached, passage, release };
}

fsp.mkdir = async function mkdir(...args) {
  mkdirs += 1;
  const step = mkdirPlan.shift() ?? 'pass';
  if (step === 'fail') throw errno('EACCES');
  if (step !== 'pass') { step.reach(); await step.passage; if (step.fails) throw errno('EACCES'); }
  return real.mkdir.apply(this, args);
};
fsp.open = async function open(file, flags, ...rest) {
  const handle = await real.open.call(this, file, flags, ...rest);
  return new Proxy(handle, {
    get(target, key) {
      if (key === 'writeFile') {
        return async (data, ...more) => {
          if (writeGate && String(data).includes(writeGate.marker)) { writeGate.reach(); await writeGate.passage; }
          return target.writeFile(data, ...more);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const { writeBackup, BackupRequestError } = require('../../runtime/backup-write.cjs');

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-r11-backup-'));
test.after(() => fs.rmSync(backupRoot, { recursive: true, force: true }));
test.beforeEach(() => { mkdirPlan = []; mkdirs = 0; writeGate = null; });

let folders = 0;
function folder(previous, name = NAME) {
  const dir = path.join(backupRoot, `f${++folders}`);
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  if (previous !== undefined) fs.writeFileSync(path.join(dir, name), previous);
  return dir;
}
const NAME = 'Canvas.thoughtdag.json';
const MIRROR = 'cli/Mirror-1a2b3c4d.thoughtdag.json';
const canvasJson = (marker) => JSON.stringify({ version: 2, name: 'Canvas', nodes: [{ id: 'n1', data: { question: marker } }], edges: [] });
const AUTOMATIC = canvasJson('OLDER_AUTOMATIC');
const NOW = canvasJson('LATEST_BACK_UP_NOW');
const filesIn = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

for (const [where, name] of [['at the folder root', NAME], ['in the cli/ drawer', MIRROR]]) {
  test(`[R11-01] a backup whose folder is slow to make cannot overwrite the backup asked for after it (${where})`, async () => {
    const dir = folder('THE_PREVIOUS_BACKUP', name);
    const slow = gate();
    mkdirPlan = [slow, 'pass'];
    const automatic = writeBackup({ dir, name, json: AUTOMATIC });
    const now = writeBackup({ dir, name, json: NOW });
    await soon(); // long enough for the later backup to finish, if nothing makes it wait
    slow.release();
    await Promise.all([automatic, now]);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), NOW, 'the backup asked for last is the one on disk, byte for byte');
    assert.deepEqual(filesIn(dir).filter((f) => f.endsWith('.tmp')), [], 'and no file of its own is left beside it');
  });
}

test('[R11-01] the later backup\'s folder being the slow one: it still ends on disk', async () => {
  const dir = folder('THE_PREVIOUS_BACKUP');
  const slow = gate();
  mkdirPlan = ['pass', slow];
  const automatic = writeBackup({ dir, name: NAME, json: AUTOMATIC });
  const now = writeBackup({ dir, name: NAME, json: NOW });
  await automatic;
  await slow.reached;
  assert.equal(fs.readFileSync(path.join(dir, NAME), 'utf8'), AUTOMATIC, 'the earlier backup is done while the later one waits');
  slow.release();
  await now;
  assert.equal(fs.readFileSync(path.join(dir, NAME), 'utf8'), NOW);
});

test('[R11-01] the earlier backup held at its folder, the later one held at its write: the later one ends on disk', async () => {
  const dir = folder('THE_PREVIOUS_BACKUP');
  const slowFolder = gate();
  const slowWrite = Object.assign(gate(), { marker: 'LATEST_BACK_UP_NOW' });
  mkdirPlan = [slowFolder, 'pass'];
  writeGate = slowWrite;
  const automatic = writeBackup({ dir, name: NAME, json: AUTOMATIC });
  const now = writeBackup({ dir, name: NAME, json: NOW });
  await soon();
  slowFolder.release();
  await soon();
  slowWrite.release();
  await Promise.all([automatic, now]);
  assert.equal(fs.readFileSync(path.join(dir, NAME), 'utf8'), NOW);
  assert.deepEqual(filesIn(dir), [NAME]);
});

test('[R11-01] the earlier backup held at its write, the later one held at its folder: the later one ends on disk', async () => {
  const dir = folder('THE_PREVIOUS_BACKUP');
  const slowWrite = Object.assign(gate(), { marker: 'OLDER_AUTOMATIC' });
  const slowFolder = gate();
  mkdirPlan = ['pass', slowFolder];
  writeGate = slowWrite;
  const automatic = writeBackup({ dir, name: NAME, json: AUTOMATIC });
  await slowWrite.reached;
  const now = writeBackup({ dir, name: NAME, json: NOW });
  await soon();
  slowWrite.release();
  await automatic;
  slowFolder.release();
  await now;
  assert.equal(fs.readFileSync(path.join(dir, NAME), 'utf8'), NOW);
  assert.deepEqual(filesIn(dir), [NAME]);
});

test('[R11-01] three backups of one canvas, the first two with slow folders: the last one asked for ends on disk', async () => {
  const dir = folder('THE_PREVIOUS_BACKUP');
  const first = gate();
  const second = gate();
  mkdirPlan = [first, second, 'pass'];
  const writes = [
    writeBackup({ dir, name: NAME, json: canvasJson('FIRST') }),
    writeBackup({ dir, name: NAME, json: canvasJson('SECOND') }),
    writeBackup({ dir, name: NAME, json: canvasJson('THIRD') }),
  ];
  await soon();
  second.release(); // whichever order the folders come back in
  await soon();
  first.release();
  await Promise.all(writes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, NAME), 'utf8')).nodes[0].data.question, 'THIRD');
});

for (const [where, name] of [['at the folder root', NAME], ['in the cli/ drawer', MIRROR]]) {
  test(`[R11-01] a folder that cannot be made fails only that backup: the one behind it is written, and a retry works (${where})`, async () => {
    const dir = folder('THE_PREVIOUS_BACKUP', name);
    // the first one waits for its folder, and then the folder cannot be made
    const slow = Object.assign(gate(), { fails: true });
    mkdirPlan = [slow];
    const failing = writeBackup({ dir, name, json: AUTOMATIC });
    const behind = writeBackup({ dir, name, json: NOW });
    await soon();
    slow.release();
    await assert.rejects(failing, (error) => error.code === 'EACCES', 'the failure is reported to the one who asked');
    await behind;
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), NOW, 'the backup behind it is not refused with it');

    mkdirPlan = ['fail'];
    await assert.rejects(writeBackup({ dir, name, json: canvasJson('A_FAILED_ONE') }), (error) => error.code === 'EACCES');
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), NOW, 'the backup on disk stays as it was');
    await writeBackup({ dir, name, json: canvasJson('THE_RETRY') });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).nodes[0].data.question, 'THE_RETRY', 'and the retry goes through');
    assert.deepEqual(filesIn(dir).filter((f) => f.endsWith('.tmp')), []);
  });
}

test('[R11-01] the first backup into a drawer that does not exist yet makes the folder and writes whole', async () => {
  const dir = path.join(backupRoot, `f${++folders}`);
  fs.mkdirSync(dir);
  await Promise.all([
    writeBackup({ dir, name: MIRROR, json: AUTOMATIC }),
    writeBackup({ dir, name: MIRROR, json: NOW }),
  ]);
  assert.equal(fs.readFileSync(path.join(dir, MIRROR), 'utf8'), NOW);
  assert.deepEqual(filesIn(dir), ['cli', path.join('cli', path.basename(MIRROR))]);
});

test('[R11-01] backups of different canvases do not wait for each other', async () => {
  const dir = folder();
  const slow = gate();
  mkdirPlan = [slow, 'pass'];
  const held = writeBackup({ dir, name: 'One.thoughtdag.json', json: canvasJson('ONE') });
  await writeBackup({ dir, name: 'Two.thoughtdag.json', json: canvasJson('TWO') });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'Two.thoughtdag.json'), 'utf8')).nodes[0].data.question, 'TWO', 'the other canvas is written while this one waits for its folder');
  assert.equal(fs.existsSync(path.join(dir, 'One.thoughtdag.json')), false);
  slow.release();
  await held;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'One.thoughtdag.json'), 'utf8')).nodes[0].data.question, 'ONE');
});

test('[R11-01] a request that is not writable is refused before it touches the disk or the queue', async () => {
  const dir = folder('THE_PREVIOUS_BACKUP');
  await assert.rejects(writeBackup({ dir: 'relative', name: NAME, json: NOW }), BackupRequestError);
  await assert.rejects(writeBackup({ dir, name: '../..', json: NOW }), BackupRequestError);
  assert.equal(mkdirs, 0, 'no folder was made');
  assert.equal(fs.readFileSync(path.join(dir, NAME), 'utf8'), 'THE_PREVIOUS_BACKUP');
});
