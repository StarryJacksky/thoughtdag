// Host-side (main-process) tests, on node's own test runner.
// `npm run test:host` runs every tests/host/**/*.test.cjs;
// `npm run test:host -- <file> [...]` runs only the files named.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'tests/host';
const named = process.argv.slice(2);
const files = named.length > 0
  ? named
  : existsSync(ROOT)
    ? readdirSync(ROOT, { recursive: true }).map((f) => path.join(ROOT, String(f))).filter((f) => f.endsWith('.test.cjs')).sort()
    : [];

if (files.length === 0) {
  console.log('no host tests under ' + ROOT);
  process.exit(0);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
