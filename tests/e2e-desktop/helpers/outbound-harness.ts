import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

export const REPO = path.resolve(import.meta.dirname, '../../..');
export const electronBinary = createRequire(import.meta.url)(path.join(REPO, 'desktop/node_modules/electron')) as string;
export type Outbound = {
  external: string[];
  windows: { url: string; disposition: string; action: string }[];
  navigation: { event: string; url: string; prevented: boolean }[];
  local: { kind: string; path: string }[];
  localRequests: string[];
  registrations: string[][];
};
export const recorded = (app: ElectronApplication) => app.evaluate(() =>
  (globalThis as unknown as { tdagOutbound: Outbound }).tdagOutbound);

/** Copy only the shell; mutable production files are never edited for mutation tests. */
export function stageShell(base: string) {
  const stage = path.join(base, 'stage');
  const desktop = path.join(stage, 'desktop');
  fs.mkdirSync(desktop, { recursive: true });
  for (const name of ['server.mjs', 'dist', 'runtime', 'shared', 'node_modules', 'protocol']) {
    fs.symlinkSync(path.join(REPO, name), path.join(stage, name));
  }
  for (const name of ['preload.js', 'splash.html', 'why.mjs']) {
    if (fs.existsSync(path.join(REPO, 'desktop', name))) fs.copyFileSync(path.join(REPO, 'desktop', name), path.join(desktop, name));
  }
  fs.symlinkSync(path.join(REPO, 'desktop/node_modules'), path.join(desktop, 'node_modules'));
  let main = fs.readFileSync(path.join(REPO, 'desktop/main.js'), 'utf8');
  const mutation = process.env.TDAG_OUTBOUND_MUTATION;
  if (mutation) {
    if (mutation !== 'allow-all') throw new Error(`Unknown shell mutation: ${mutation}`);
    const guard = /const openOutside = \(url\) => \{[^\n]+\};/;
    if (!guard.test(main)) throw new Error('Could not find openOutside guard to mutate');
    main = main.replace(guard, 'const openOutside = (url) => { shell.openExternal(url); };');
  }
  fs.writeFileSync(path.join(desktop, 'main.js'), main);
  fs.copyFileSync(path.join(REPO, 'tests/e2e-desktop/helpers/outbound-recorder.cjs'), path.join(desktop, 'outbound-recorder.cjs'));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'desktop/package.json'), 'utf8'));
  pkg.main = 'outbound-recorder.cjs';
  fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg, null, 2));
  return desktop;
}

export async function launchProbe(base: string) {
  const packaged = process.env.TDAG_PACKAGED_EXECUTABLE;
  return electron.launch({
    timeout: 20_000,
    executablePath: packaged || electronBinary,
    args: [...(packaged ? [] : [stageShell(base)]), `--user-data-dir=${path.join(base, 'profile')}`, '--lang=en'],
    cwd: base,
    env: { ...process.env, TD_SESSION_ROOTS: '{}', THOUGHTDAG_HOME: path.join(base, 'home') },
  });
}

export function redact(value: unknown, base: string) {
  return JSON.stringify(value, null, 2).replaceAll(REPO, '<repo>').replaceAll(base, '<temp>');
}
