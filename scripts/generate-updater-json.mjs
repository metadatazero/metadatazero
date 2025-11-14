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
  console.error('Usage: node generate-updater-json.mjs <platform> <target>');
  console.error('Example: node generate-updater-json.mjs darwin x86_64-apple-darwin');
  process.exit(1);
}

const GITHUB_REPO = 'metadatazero/metadatazero';

function getTargetPath(target) {
  if (target.includes('universal')) {
    return `src-tauri/target/universal-apple-darwin/release/bundle`;
  } else if (target === 'default') {
    return `src-tauri/target/release/bundle`;
  } else {
    return `src-tauri/target/${target}/release/bundle`;
  }
}

function getPlatformInfo(platform, target) {
  const basePath = getTargetPath(target);

  switch (platform) {
    case 'darwin':
      const arch = target.includes('aarch64') ? 'arm64' : 'x64';
      const platformArch = target.includes('aarch64') ? 'aarch64' : 'x86_64';
      return {
        bundlePath: path.join(basePath, 'macos'),
        signatureFile: `MetadataZero-${version}-mac-${arch}.app.tar.gz.sig`,
        downloadFile: `MetadataZero-${version}-mac-${arch}.app.tar.gz`,
        platformName: `darwin-${platformArch}`,
        assetName: `MetadataZero-${version}-mac-${arch}.app.tar.gz`
      };

    case 'linux':
      return {
        bundlePath: path.join(basePath, 'appimage'),
        signatureFile: `MetadataZero-${version}-linux-x64.AppImage.sig`,
        downloadFile: `MetadataZero-${version}-linux-x64.AppImage`,
        platformName: 'linux-x86_64',
        assetName: `MetadataZero-${version}-linux-x64.AppImage`
      };

    case 'windows':
      return {
        bundlePath: path.join(basePath, 'nsis'),
        signatureFile: `MetadataZero-${version}-win-x64.exe.sig`,
        downloadFile: `MetadataZero-${version}-win-x64.exe`,
        platformName: 'windows-x86_64',
        assetName: `MetadataZero-${version}-win-x64.exe`
      };

    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

function generateLatestJson(platform, target) {
  const info = getPlatformInfo(platform, target);
  const sigPath = path.join(info.bundlePath, info.signatureFile);

  if (!fs.existsSync(sigPath)) {
    console.log(`Signature file not found: ${sigPath}`);
    console.log('Skipping latest.json generation');
    return null;
  }

  const signature = fs.readFileSync(sigPath, 'utf8').trim();
  const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${info.assetName}`;

  const latestJson = {
    version: `v${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      [info.platformName]: {
        signature,
        url: downloadUrl
      }
    }
  };

  const outputPath = path.join(info.bundlePath, 'latest.json');
  fs.writeFileSync(outputPath, JSON.stringify(latestJson, null, 2));

  console.log(`✓ Generated ${outputPath}`);
  console.log(`  Platform: ${info.platformName}`);
  console.log(`  Version: v${version}`);
  console.log(`  URL: ${downloadUrl}`);

  return outputPath;
}

try {
  generateLatestJson(platform, target);
} catch (err) {
  console.error('Failed to generate latest.json:', err.message);
  process.exit(1);
}
