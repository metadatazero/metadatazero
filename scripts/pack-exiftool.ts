import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { EXIFTOOL_VERSION, LIB_DIR, hostSidecarPath, isPacked, isWindows } from './exiftool-host.ts';

// ExifTool is a Perl script, so it needs a perl interpreter on the user's
// machine. PAR::Packer folds the interpreter and every module it loads into one
// executable, which is how the official Windows build is made. Doing the same on
// Unix is what lets the app run inside the Flatpak sandbox, where there is no
// perl at all.
if (isWindows()) {
  console.log('✓ Windows ships an already-packed ExifTool, nothing to do');
  process.exit(0);
}

const sidecar = hostSidecarPath();
const packed = `${sidecar}.packed`;

if (isPacked()) {
  console.log('✓ ExifTool is already packed');
  process.exit(0);
}

if (!fs.existsSync(sidecar) || !fs.existsSync(LIB_DIR)) {
  console.error(`✗ Run scripts/download-exiftool.ts first: ${sidecar} and lib/ must both exist.`);
  process.exit(1);
}

const pack = spawnSync(
  'pp',
  ['-o', packed, '-I', LIB_DIR, '-M', 'Image::ExifTool::*', sidecar],
  { stdio: 'inherit' }
);

if (pack.error || pack.status !== 0) {
  console.error(`✗ pp failed: ${pack.error?.message ?? `exit ${pack.status}`}`);
  console.error('  Install PAR::Packer (apt install libpar-packer-perl, or cpanm PAR::Packer).');
  process.exit(1);
}

fs.renameSync(packed, sidecar);
fs.chmodSync(sidecar, 0o755);

// Every module is inside the executable now, so the 20 MB source tree would only
// bloat the installer.
fs.rmSync(LIB_DIR, { recursive: true, force: true });

// A packed binary that cannot start is worse than no packing at all: prove it
// runs before letting the build continue.
const check = spawnSync(sidecar, ['-ver'], { encoding: 'utf8' });
const reported = check.stdout?.trim();

if (reported !== EXIFTOOL_VERSION) {
  console.error(`✗ Packed binary reported "${reported}", expected "${EXIFTOOL_VERSION}"`);
  console.error(check.stderr ?? '');
  process.exit(1);
}

const megabytes = (fs.statSync(sidecar).size / 1024 / 1024).toFixed(1);
console.log(`✓ Packed self-contained ExifTool ${reported} (${megabytes} MB)`);
