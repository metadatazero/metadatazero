import fs from 'node:fs';
import path from 'node:path';
import { LAYOUT, artifactName, parseArgs } from './targets.ts';

const { bundleDir, os, arch } = parseArgs();

// Matching on the suffix rather than on Tauri's generated filename keeps this
// working when Tauri changes how it names bundles.
function candidates(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const wantsSignature = ext.endsWith('.sig');
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(ext) && file.endsWith('.sig') === wantsSignature);
}

let failed = false;

console.log(`\nRenaming ${os}-${arch} artifacts in ${bundleDir}`);

for (const { dir, ext } of LAYOUT[os]) {
  const fullDir = path.join(bundleDir, dir);
  const finalName = artifactName(os, arch, ext);
  const found = candidates(fullDir, ext);

  if (found.includes(finalName)) {
    console.log(`= ${dir}/${finalName}`);
    continue;
  }

  if (found.length !== 1) {
    console.error(`✗ ${fullDir}: expected exactly one "*${ext}", found ${found.length}`);
    failed = true;
    continue;
  }

  fs.renameSync(path.join(fullDir, found[0]), path.join(fullDir, finalName));
  console.log(`→ ${dir}/${found[0]} → ${finalName}`);
}

if (failed) {
  console.error('\nSome artifacts were missing. Failing so the release is not published incomplete.');
  process.exit(1);
}

console.log('');
