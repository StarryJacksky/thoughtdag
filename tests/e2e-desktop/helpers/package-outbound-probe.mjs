// Offline, unsigned host-architecture .app used by outbound-probe.spec.ts.
// No install/client-build/sign/publish steps. A recorder entrypoint replaces all OS
// opens before loading the copied main.js. This is not a release artifact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { REPO, stageShell } from './outbound-harness.ts';

if (process.platform !== 'darwin') throw new Error('This probe packages macOS only');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tdag-outbound-pack-')));
const desktop = stageShell(base);
// electron-builder's dependency collector follows a symlinked node_modules
// into the source workspace and loses some updater dependency locations.
// A physical copy keeps collection rooted in the staged desktop package.
fs.unlinkSync(path.join(desktop, 'node_modules'));
fs.cpSync(path.join(REPO, 'desktop/node_modules'), path.join(desktop, 'node_modules'), {
  recursive: true, mode: fs.constants.COPYFILE_FICLONE,
});
const payload = path.join(base, 'payload');
fs.mkdirSync(payload);
for (const name of ['server.mjs', 'dist', 'runtime', 'shared']) {
  fs.cpSync(path.join(REPO, name), path.join(payload, name), { recursive: true });
}
const hasWhy = fs.existsSync(path.join(REPO, 'desktop/why.mjs'));
if (hasWhy) {
  fs.copyFileSync(path.join(REPO, 'desktop/why.mjs'), path.join(payload, 'why.mjs'));
}
const require = createRequire(path.join(REPO, 'desktop/package.json'));
const { build, Platform, Arch } = require('electron-builder');
const electronVersion = require('electron/package.json').version;
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
// Do not inherit the release scripts, signing config, or publish targets.
delete pkg.build;
delete pkg.scripts;
delete pkg.devDependencies;
fs.writeFileSync(path.join(desktop, 'package.json'), JSON.stringify(pkg, null, 2));
await build({
  projectDir: desktop, targets: Platform.MAC.createTarget('dir', process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
  publish: 'never',
  config: {
    appId: 'io.thoughtdag.outbound-probe', productName: 'ThoughtDAG Probe',
    electronVersion, electronDist: path.join(REPO, 'desktop/node_modules/electron/dist'),
    directories: { output: path.join(base, 'out') },
    files: ['main.js', 'preload.js', 'splash.html', 'outbound-recorder.cjs', 'package.json'],
    extraResources: [{ from: payload, to: 'payload' }],
    asar: true, npmRebuild: false, forceCodeSigning: false,
    mac: { identity: null, notarize: false, hardenedRuntime: false, gatekeeperAssess: false },
    afterPack: async (context) => {
      const resources = path.join(context.appOutDir, 'ThoughtDAG Probe.app/Contents/Resources');
      // Use already installed dependencies: no npm install and no network.
      // This intentionally tests a superset of the release payload's modules.
      fs.cpSync(path.join(REPO, 'node_modules'), path.join(resources, 'payload/node_modules'), {
        recursive: true, mode: fs.constants.COPYFILE_FICLONE,
      });
    },
  },
});
const executable = path.join(base, 'out', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'ThoughtDAG Probe.app/Contents/MacOS/ThoughtDAG Probe');
const manifest = { executable, base, electronVersion, architecture: process.arch,
  distIndexSha256: createHash('sha256').update(fs.readFileSync(path.join(payload, 'dist/index.html'))).digest('hex'),
  limitations: ['unsigned, unnotarized directory app; no DMG/ZIP or Gatekeeper verification',
    'recorder bootstrap replaces OS opens, protocol registration and updater',
    'existing dist copied without a full client build', 'installed dependency superset, not npm production-only payload',
    ...(!hasWhy ? ['why.mjs absent locally; why library behavior is outside this outbound probe'] : [])] };
fs.writeFileSync(path.join(base, 'probe-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
