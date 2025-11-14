#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXIFTOOL_VERSION = '13.36';
const EXIFTOOL_SHA256 = 'f70ecbcdccc18268d4d3c290faf8cf73b1cf128e3e7f8671e24d6604cae4dc73';
const EXIFTOOL_WINDOWS_SHA256 = '6e2ba32f10883aec180f71cf257fd8ac7d4a9d12f7c23e0a965f6f4b7fa7d0e9';
const BINARIES_DIR = path.join(__dirname, '..', 'src-tauri', 'binaries');

function verifySHA256(filePath, expectedHash) {
  const fileBuffer = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(fileBuffer);
  const actualHash = hash.digest('hex');

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum verification failed!\n` +
      `  Expected: ${expectedHash}\n` +
      `  Actual:   ${actualHash}`
    );
  }

  console.log('✓ Checksum verified');
}

function checkBinaries() {
  const requiredBinaries = [
    'exiftool-x86_64-apple-darwin',
    'exiftool-aarch64-apple-darwin',
    'exiftool-x86_64-unknown-linux-gnu',
    'exiftool-aarch64-unknown-linux-gnu',
    'exiftool-x86_64-pc-windows-msvc.exe'
  ];

  const libDir = path.join(BINARIES_DIR, 'lib');
  const exiftoolFilesDir = path.join(BINARIES_DIR, 'exiftool_files');

  const allExist = requiredBinaries.every(bin =>
    fs.existsSync(path.join(BINARIES_DIR, bin))
  ) && fs.existsSync(libDir) && fs.existsSync(exiftoolFilesDir);

  return allExist;
}

function downloadWindows() {
  console.log(`Downloading ExifTool ${EXIFTOOL_VERSION} for Windows...`);

  const zipFile = path.join(BINARIES_DIR, 'exiftool-windows.zip');
  const extractBaseDir = path.join(BINARIES_DIR, `exiftool-${EXIFTOOL_VERSION}_64`);

  try {
    execSync(
      `curl -L -o "${zipFile}" "https://sourceforge.net/projects/exiftool/files/exiftool-${EXIFTOOL_VERSION}_64.zip/download"`,
      { stdio: 'inherit', cwd: BINARIES_DIR }
    );

    verifySHA256(zipFile, EXIFTOOL_WINDOWS_SHA256);

    const destExiftool = path.join(BINARIES_DIR, 'exiftool-x86_64-pc-windows-msvc.exe');

    execSync(
      `unzip -q "${zipFile}" -d "${BINARIES_DIR}"`,
      { cwd: BINARIES_DIR }
    );

    const extractedFile = path.join(extractBaseDir, 'exiftool(-k).exe');
    fs.renameSync(extractedFile, destExiftool);

    const sourceExiftoolFiles = path.join(extractBaseDir, 'exiftool_files');
    const destExiftoolFiles = path.join(BINARIES_DIR, 'exiftool_files');

    if (fs.existsSync(destExiftoolFiles)) {
      fs.rmSync(destExiftoolFiles, { recursive: true, force: true });
    }

    if (fs.existsSync(sourceExiftoolFiles)) {
      execSync(`cp -r "${sourceExiftoolFiles}" "${destExiftoolFiles}"`);
      execSync(`chmod -R u+w "${destExiftoolFiles}"`);
    }

    fs.rmSync(zipFile, { force: true });

    if (fs.existsSync(extractBaseDir)) {
      execSync(`chmod -R +w "${extractBaseDir}"`);
      fs.rmSync(extractBaseDir, { recursive: true, force: true });
    }

    console.log('✓ ExifTool Windows binary downloaded and configured');
  } catch (err) {
    console.error('Failed to download ExifTool for Windows:', err.message);
    process.exit(1);
  }
}

function downloadAndSetup() {
  console.log(`Downloading ExifTool ${EXIFTOOL_VERSION}...`);

  const tarFile = path.join(BINARIES_DIR, 'exiftool.tar.gz');
  const extractDir = path.join(BINARIES_DIR, `exiftool-${EXIFTOOL_VERSION}`);

  try {
    execSync(
      `curl -L -o "${tarFile}" "https://github.com/exiftool/exiftool/archive/refs/tags/${EXIFTOOL_VERSION}.tar.gz"`,
      { stdio: 'inherit', cwd: BINARIES_DIR }
    );

    verifySHA256(tarFile, EXIFTOOL_SHA256);

    execSync(`tar -xzf "${tarFile}"`, { cwd: BINARIES_DIR });

    const sourceExiftool = path.join(extractDir, 'exiftool');
    const platforms = [
      'exiftool-x86_64-apple-darwin',
      'exiftool-aarch64-apple-darwin',
      'exiftool-x86_64-unknown-linux-gnu',
      'exiftool-aarch64-unknown-linux-gnu'
    ];

    platforms.forEach(target => {
      const dest = path.join(BINARIES_DIR, target);
      fs.copyFileSync(sourceExiftool, dest);
      fs.chmodSync(dest, 0o755);
    });

    const sourceLib = path.join(extractDir, 'lib');
    const destLib = path.join(BINARIES_DIR, 'lib');
    if (fs.existsSync(destLib)) {
      fs.rmSync(destLib, { recursive: true, force: true });
    }
    execSync(`cp -r "${sourceLib}" "${destLib}"`);

    fs.rmSync(tarFile, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });

    console.log(`✓ ExifTool ${EXIFTOOL_VERSION} Unix binaries configured`);

    downloadWindows();
  } catch (err) {
    console.error('Failed to download ExifTool:', err.message);
    process.exit(1);
  }
}

function main() {
  if (!fs.existsSync(BINARIES_DIR)) {
    fs.mkdirSync(BINARIES_DIR, { recursive: true });
  }

  if (checkBinaries()) {
    console.log('✓ ExifTool binaries already configured');
    return;
  }

  downloadAndSetup();
}

main();
