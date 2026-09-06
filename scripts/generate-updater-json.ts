import fs from 'node:fs';
import path from 'node:path';
import { VERSION, parseArgs, updaterFor } from './targets.ts';

const { bundleDir, os, arch } = parseArgs();

// Must stay in sync with plugins.updater.endpoints in src-tauri/tauri.conf.json.
const GITHUB_REPO = 'metadatazero/metadatazero';

const updater = updaterFor(os, arch);
const signaturePath = path.join(bundleDir, updater.dir, `${updater.file}.sig`);

if (!fs.existsSync(signaturePath)) {
  console.error(`✗ Signature not found: ${signaturePath}`);
  console.error('  The updater cannot ship without it. Check TAURI_SIGNING_PRIVATE_KEY.');
  process.exit(1);
}

const latestJson = {
  version: `v${VERSION}`,
  pub_date: new Date().toISOString(),
  platforms: {
    [updater.platform]: {
      signature: fs.readFileSync(signaturePath, 'utf8').trim(),
      url: `https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/${updater.file}`,
    },
  },
};

// One known location per job, so the workflow needs no per-OS upload path.
const outputPath = path.join(bundleDir, 'latest.json');
fs.writeFileSync(outputPath, JSON.stringify(latestJson, null, 2));

console.log(`✓ Generated ${outputPath} for ${updater.platform}`);
