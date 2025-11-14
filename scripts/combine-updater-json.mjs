#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const artifactsDir = path.join(__dirname, '..', 'artifacts');

const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')
);
const version = tauriConfig.version;

const jsonFiles = [
  'latest-json-macos-x86_64/latest.json',
  'latest-json-macos-aarch64/latest.json',
  'latest-json-linux/latest.json',
  'latest-json-windows/latest.json'
];

function combineLatestJson() {
  const combined = {
    version: `v${version}`,
    pub_date: new Date().toISOString(),
    platforms: {}
  };

  jsonFiles.forEach(file => {
    const filePath = path.join(artifactsDir, file);
    if (fs.existsSync(filePath)) {
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        Object.assign(combined.platforms, content.platforms);
        console.log(`✓ Merged ${file}`);
      } catch (err) {
        console.log(`⚠ Skipped ${file}: ${err.message}`);
      }
    } else {
      console.log(`⚠ Not found: ${file}`);
    }
  });

  if (Object.keys(combined.platforms).length === 0) {
    console.error('No platforms found in latest.json files');
    process.exit(1);
  }

  const outputPath = path.join(artifactsDir, 'latest.json');
  fs.writeFileSync(outputPath, JSON.stringify(combined, null, 2));

  console.log(`\n✓ Generated combined latest.json with ${Object.keys(combined.platforms).length} platforms`);
  console.log(`  Platforms: ${Object.keys(combined.platforms).join(', ')}`);
  console.log(`  Output: ${outputPath}`);

  return outputPath;
}

try {
  combineLatestJson();
} catch (err) {
  console.error('Failed to combine latest.json files:', err.message);
  process.exit(1);
}
