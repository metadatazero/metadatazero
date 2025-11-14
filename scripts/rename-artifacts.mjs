#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const platform = args[0];
const target = args[1];

const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const version = tauriConfig.version;

if (!platform || !target) {
  console.error('Usage: node rename-artifacts.mjs <platform> <target>');
  process.exit(1);
}

function getTargetPath(target) {
  if (target === 'default') {
    return 'src-tauri/target/release/bundle';
  } else {
    return `src-tauri/target/${target}/release/bundle`;
  }
}

function renameFile(dir, oldName, newName) {
  const oldPath = path.join(dir, oldName);
  const newPath = path.join(dir, newName);

  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
    console.log(`✓ Renamed: ${oldName} → ${newName}`);
    return true;
  } else {
    console.log(`⚠ Not found: ${oldPath}`);
    return false;
  }
}

function renameMacOS(target) {
  const basePath = getTargetPath(target);
  const arch = target.includes('aarch64') ? 'arm64' : 'x64';
  const oldArch = target.includes('aarch64') ? 'aarch64' : 'x64';

  const dmgDir = path.join(basePath, 'dmg');
  const macosDir = path.join(basePath, 'macos');

  renameFile(dmgDir, `MetadataZero_${version}_${oldArch}.dmg`, `MetadataZero-${version}-mac-${arch}.dmg`);
  renameFile(macosDir, 'MetadataZero.app.tar.gz', `MetadataZero-${version}-mac-${arch}.app.tar.gz`);
  renameFile(macosDir, 'MetadataZero.app.tar.gz.sig', `MetadataZero-${version}-mac-${arch}.app.tar.gz.sig`);
}

function renameLinux() {
  const basePath = getTargetPath('default');

  const appimageDir = path.join(basePath, 'appimage');
  const debDir = path.join(basePath, 'deb');

  renameFile(appimageDir, `MetadataZero_${version}_amd64.AppImage`, `MetadataZero-${version}-linux-x64.AppImage`);
  renameFile(appimageDir, `MetadataZero_${version}_amd64.AppImage.sig`, `MetadataZero-${version}-linux-x64.AppImage.sig`);
  renameFile(debDir, `MetadataZero_${version}_amd64.deb`, `MetadataZero-${version}-linux-x64.deb`);
}

function renameWindows() {
  const basePath = getTargetPath('default');

  const nsisDir = path.join(basePath, 'nsis');
  const msiDir = path.join(basePath, 'msi');

  renameFile(nsisDir, `MetadataZero_${version}_x64-setup.exe`, `MetadataZero-${version}-win-x64.exe`);
  renameFile(nsisDir, `MetadataZero_${version}_x64-setup.exe.sig`, `MetadataZero-${version}-win-x64.exe.sig`);
  renameFile(msiDir, `MetadataZero_${version}_x64_en-US.msi`, `MetadataZero-${version}-win-x64.msi`);
  renameFile(msiDir, `MetadataZero_${version}_x64_en-US.msi.sig`, `MetadataZero-${version}-win-x64.msi.sig`);
}

try {
  console.log(`\nRenaming ${platform} artifacts...`);

  switch (platform) {
    case 'darwin':
      renameMacOS(target);
      break;
    case 'linux':
      renameLinux();
      break;
    case 'windows':
      renameWindows();
      break;
    default:
      console.error(`Unknown platform: ${platform}`);
      process.exit(1);
  }

  console.log('');
} catch (err) {
  console.error('Failed to rename artifacts:', err.message);
  process.exit(1);
}
