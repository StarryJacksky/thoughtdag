// The LaTeX engine the app brings (Tectonic), so that a LaTeX source can be
// compiled to a PDF on a machine with no TeX installed: one executable per
// platform, from the project's own release, checked against the SHA-256 the
// release published before it is used. It fetches the LaTeX packages a
// source needs the first time it needs them, and keeps them.
//
// Written to desktop/vendor/tectonic/<os>-<arch>/, which electron-builder
// copies into the app (see "extraResources" in package.json) and the app
// finds at <resources>/tectonic/. Fetched archives are kept in
// desktop/.cache/tectonic/ so a rebuild does not fetch them again.
//
//   node scripts/fetch-tectonic.mjs                 this machine's platform
//   node scripts/fetch-tectonic.mjs mac-arm64 mac-x64 win-x64 linux-x64
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.17.0';
/** The release's own archives and the SHA-256 it published for each (GitHub release tectonic@0.17.0, 2026-07-27). */
const ASSETS = {
  'mac-arm64': { name: `tectonic-${VERSION}-aarch64-apple-darwin.tar.gz`, sha256: 'a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667', binary: 'tectonic' },
  'mac-x64': { name: `tectonic-${VERSION}-x86_64-apple-darwin.tar.gz`, sha256: '7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80', binary: 'tectonic' },
  'win-x64': { name: `tectonic-${VERSION}-x86_64-pc-windows-msvc.zip`, sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f', binary: 'tectonic.exe' },
  'linux-x64': { name: `tectonic-${VERSION}-x86_64-unknown-linux-gnu.tar.gz`, sha256: '1a715688baf591e650c8aeb160ae934e181685eecbb38b317de30b269ac5d606', binary: 'tectonic' },
};

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cache = path.join(desktop, '.cache', 'tectonic');
const vendor = path.join(desktop, 'vendor', 'tectonic');
const here = `${{ darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]}-${process.arch}`;
const targets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : [here];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

for (const target of targets) {
  const asset = ASSETS[target];
  if (!asset) { console.error(`no Tectonic build is known for ${target}; known: ${Object.keys(ASSETS).join(', ')}`); process.exit(1); }
  const out = path.join(vendor, target);
  const installed = path.join(out, asset.binary);
  if (existsSync(installed) && existsSync(path.join(out, 'VERSION')) && readFileSync(path.join(out, 'VERSION'), 'utf8').trim() === `${VERSION} ${asset.sha256}`) {
    console.log(`tectonic ${VERSION} for ${target}: already here`);
    continue;
  }
  mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, asset.name);
  if (!existsSync(archive) || sha256(readFileSync(archive)) !== asset.sha256) {
    const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/${asset.name}`;
    console.log(`fetching ${url}`);
    const response = await fetch(url);
    if (!response.ok) { console.error(`could not fetch ${asset.name}: ${response.status}`); process.exit(1); }
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const got = sha256(readFileSync(archive));
  if (got !== asset.sha256) {
    rmSync(archive, { force: true });
    console.error(`${asset.name} is not the release's archive: SHA-256 ${got}, expected ${asset.sha256}. Nothing was used.`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  const unpack = path.join(cache, `unpack-${target}`);
  rmSync(unpack, { recursive: true, force: true });
  mkdirSync(unpack, { recursive: true });
  // bsdtar reads .zip as well as .tar.gz, on macOS, on Linux and on Windows 10 and later
  execFileSync('tar', ['-xf', archive, '-C', unpack], { stdio: 'inherit' });
  mkdirSync(out, { recursive: true });
  copyFileSync(path.join(unpack, asset.binary), installed);
  if (asset.binary === 'tectonic') chmodSync(installed, 0o755);
  rmSync(unpack, { recursive: true, force: true });
  writeFileSync(path.join(out, 'VERSION'), `${VERSION} ${asset.sha256}\n`);
  writeFileSync(path.join(out, 'NOTICE'), `Tectonic ${VERSION} (https://tectonic-typesetting.github.io), MIT License.\nThe LaTeX packages it fetches are under their own licenses (mostly LPPL).\n`);
  console.log(`tectonic ${VERSION} for ${target}: ${installed}`);
}
