import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BINARIES_DIR, isWindows } from './exiftool-host.ts';
import { QPDF_ASSETS, qpdfUrl, readTools } from './tools.ts';

const { qpdf } = readTools();
const QPDF_VERSION = qpdf.version;

const QPDF_DIR = path.join(BINARIES_DIR, 'qpdf');
const MARKER = path.join(QPDF_DIR, 'VERSION');
const BINARY = path.join(QPDF_DIR, 'bin', isWindows() ? 'qpdf.exe' : 'qpdf');

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: BINARIES_DIR });

  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}

// The zips ship each library twice, the real file and a soname symlink to it.
// Tauri copies symlinks as plain files, so keep one copy under the soname the
// binary actually loads.
function copyLibraries(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  const entries = fs.readdirSync(from);
  const isLink = (entry: string) => fs.lstatSync(path.join(from, entry)).isSymbolicLink();
  const linked = new Set(entries.filter(isLink).map((entry) => path.basename(fs.readlinkSync(path.join(from, entry)))));

  for (const entry of entries) {
    if (linked.has(entry) && !isLink(entry)) continue;
    fs.copyFileSync(path.join(from, entry), path.join(to, entry));
  }
}

function download(): void {
  const key = `${process.platform}-${process.arch}`;
  const asset = QPDF_ASSETS[key];
  if (!asset) throw new Error(`Unsupported host: ${key}`);
  const expected = qpdf.sha256[asset];

  console.log(`Downloading QPDF ${QPDF_VERSION}...`);

  const zipFile = path.join(BINARIES_DIR, 'qpdf.zip');
  const extractDir = path.join(BINARIES_DIR, 'qpdf-extract');
  fs.rmSync(extractDir, { recursive: true, force: true });

  run('curl', ['-fL', '-o', zipFile, qpdfUrl(QPDF_VERSION, asset)]);

  const actual = crypto.createHash('sha256').update(fs.readFileSync(zipFile)).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum verification failed for QPDF!\n  Expected: ${expected}\n  Actual:   ${actual}`);
  }
  console.log('✓ Checksum verified');

  run('unzip', ['-q', '-o', zipFile, '-d', extractDir]);

  const root = isWindows() ? path.join(extractDir, `qpdf-${QPDF_VERSION}-${asset}`) : extractDir;
  fs.rmSync(QPDF_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(BINARY), { recursive: true });

  if (isWindows()) {
    for (const entry of fs.readdirSync(path.join(root, 'bin'))) {
      if (entry === 'qpdf.exe' || entry.endsWith('.dll')) {
        fs.copyFileSync(path.join(root, 'bin', entry), path.join(QPDF_DIR, 'bin', entry));
      }
    }
  } else {
    fs.copyFileSync(path.join(root, 'bin', 'qpdf'), BINARY);
    fs.chmodSync(BINARY, 0o755);
    copyLibraries(path.join(root, 'lib'), path.join(QPDF_DIR, 'lib'));
  }

  fs.writeFileSync(MARKER, QPDF_VERSION);
  fs.rmSync(zipFile, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });

  console.log(`✓ QPDF ${QPDF_VERSION} ready`);
}

fs.mkdirSync(BINARIES_DIR, { recursive: true });

const installed = fs.existsSync(MARKER) && fs.readFileSync(MARKER, 'utf8') === QPDF_VERSION && fs.existsSync(BINARY);

if (installed) {
  console.log('✓ QPDF already configured');
} else {
  try {
    download();
  } catch (err) {
    console.error('Failed to download QPDF:', (err as Error).message);
    process.exit(1);
  }
}
