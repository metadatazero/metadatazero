import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  BINARIES_DIR,
  EXIFTOOL_SHA256,
  EXIFTOOL_VERSION,
  EXIFTOOL_WINDOWS_SHA256,
  LIB_DIR,
  WINDOWS_FILES_DIR,
  hostSidecarPath,
  isPacked,
  isWindows,
} from './exiftool-host.ts';

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: BINARIES_DIR });

  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}

function verifySHA256(filePath: string, expectedHash: string): void {
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum verification failed for ${path.basename(filePath)}!\n` +
      `  Expected: ${expectedHash}\n` +
      `  Actual:   ${actualHash}`
    );
  }

  console.log('✓ Checksum verified');
}

function downloadWindows(): void {
  console.log(`Downloading ExifTool ${EXIFTOOL_VERSION} for Windows...`);

  const zipFile = path.join(BINARIES_DIR, 'exiftool-windows.zip');
  const extractBaseDir = path.join(BINARIES_DIR, `exiftool-${EXIFTOOL_VERSION}_64`);

  run('curl', ['-fL', '-o', zipFile, `https://sourceforge.net/projects/exiftool/files/exiftool-${EXIFTOOL_VERSION}_64.zip/download`]);
  verifySHA256(zipFile, EXIFTOOL_WINDOWS_SHA256);
  run('unzip', ['-q', '-o', zipFile, '-d', BINARIES_DIR]);

  fs.renameSync(path.join(extractBaseDir, 'exiftool(-k).exe'), hostSidecarPath());

  fs.rmSync(WINDOWS_FILES_DIR, { recursive: true, force: true });
  fs.cpSync(path.join(extractBaseDir, 'exiftool_files'), WINDOWS_FILES_DIR, { recursive: true });
  // The zip marks these files read-only, so Windows refuses to overwrite the copies
  // the build makes of them and the installed files are read-only too.
  for (const entry of fs.readdirSync(WINDOWS_FILES_DIR, { recursive: true, withFileTypes: true })) {
    fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
  }

  fs.rmSync(zipFile, { force: true });
  fs.rmSync(extractBaseDir, { recursive: true, force: true });

  console.log('✓ ExifTool Windows binary ready');
}

function downloadUnix(): void {
  console.log(`Downloading ExifTool ${EXIFTOOL_VERSION}...`);

  const tarFile = path.join(BINARIES_DIR, 'exiftool.tar.gz');
  const extractDir = path.join(BINARIES_DIR, `exiftool-${EXIFTOOL_VERSION}`);

  run('curl', ['-fL', '-o', tarFile, `https://github.com/exiftool/exiftool/archive/refs/tags/${EXIFTOOL_VERSION}.tar.gz`]);
  verifySHA256(tarFile, EXIFTOOL_SHA256);
  run('tar', ['-xzf', tarFile]);

  fs.copyFileSync(path.join(extractDir, 'exiftool'), hostSidecarPath());
  fs.chmodSync(hostSidecarPath(), 0o755);

  fs.rmSync(LIB_DIR, { recursive: true, force: true });
  fs.cpSync(path.join(extractDir, 'lib'), LIB_DIR, { recursive: true });

  fs.rmSync(tarFile, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });

  console.log(`✓ ExifTool ${EXIFTOOL_VERSION} ready at ${path.basename(hostSidecarPath())}`);
}

function isConfigured(): boolean {
  if (isPacked()) return !isWindows() || fs.existsSync(WINDOWS_FILES_DIR);
  return fs.existsSync(hostSidecarPath()) && fs.existsSync(LIB_DIR);
}

fs.mkdirSync(BINARIES_DIR, { recursive: true });

if (isConfigured()) {
  console.log('✓ ExifTool already configured');
} else {
  try {
    if (isWindows()) downloadWindows();
    else downloadUnix();
  } catch (err) {
    console.error('Failed to download ExifTool:', (err as Error).message);
    process.exit(1);
  }
}
