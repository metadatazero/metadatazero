import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from './targets.ts';

interface UpdaterEntry {
  signature: string;
  url: string;
}

const artifactsDir = path.join(import.meta.dirname, '..', 'artifacts');

const combined = {
  version: `v${VERSION}`,
  pub_date: new Date().toISOString(),
  platforms: {} as Record<string, UpdaterEntry>,
};

// One directory per build job, named latest-json-<os>-<arch> by the workflow.
const sources = fs.existsSync(artifactsDir)
  ? fs.readdirSync(artifactsDir).filter((entry) => entry.startsWith('latest-json-')).sort()
  : [];

for (const source of sources) {
  const filePath = path.join(artifactsDir, source, 'latest.json');

  if (!fs.existsSync(filePath)) {
    console.error(`✗ ${source} has no latest.json`);
    process.exit(1);
  }

  const platforms: Record<string, UpdaterEntry> = JSON.parse(fs.readFileSync(filePath, 'utf8')).platforms;

  for (const [name, entry] of Object.entries(platforms)) {
    if (combined.platforms[name]) {
      console.error(`✗ Two jobs both produced updater entry "${name}"`);
      process.exit(1);
    }
    combined.platforms[name] = entry;
  }

  console.log(`✓ Merged ${source}: ${Object.keys(platforms).join(', ')}`);
}

if (Object.keys(combined.platforms).length === 0) {
  console.error('✗ No latest.json files found in artifacts/');
  process.exit(1);
}

const outputPath = path.join(artifactsDir, 'latest.json');
fs.writeFileSync(outputPath, JSON.stringify(combined, null, 2));

console.log(`\n✓ ${outputPath} covers ${Object.keys(combined.platforms).join(', ')}`);
