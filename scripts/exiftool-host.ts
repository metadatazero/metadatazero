import fs from 'node:fs';
import path from 'node:path';

export const EXIFTOOL_VERSION = '13.36';
export const EXIFTOOL_SHA256 = 'f70ecbcdccc18268d4d3c290faf8cf73b1cf128e3e7f8671e24d6604cae4dc73';
export const EXIFTOOL_WINDOWS_SHA256 = '6e2ba32f10883aec180f71cf257fd8ac7d4a9d12f7c23e0a965f6f4b7fa7d0e9';

export const BINARIES_DIR = path.join(import.meta.dirname, '..', 'src-tauri', 'binaries');
export const LIB_DIR = path.join(BINARIES_DIR, 'lib');
export const WINDOWS_FILES_DIR = path.join(BINARIES_DIR, 'exiftool_files');

const SIDECARS: Record<string, string> = {
  'darwin-x64': 'exiftool-x86_64-apple-darwin',
  'darwin-arm64': 'exiftool-aarch64-apple-darwin',
  'linux-x64': 'exiftool-x86_64-unknown-linux-gnu',
  'linux-arm64': 'exiftool-aarch64-unknown-linux-gnu',
  'win32-x64': 'exiftool-x86_64-pc-windows-msvc.exe',
};

// Only the running host's sidecar is built. Tauri bundles binaries/ wholesale,
// so the other platforms' copies would just bloat every installer.
export function hostSidecarPath(): string {
  const key = `${process.platform}-${process.arch}`;
  const name = SIDECARS[key];

  if (!name) {
    console.error(`✗ Unsupported host: ${key}`);
    console.error(`  Known: ${Object.keys(SIDECARS).join(', ')}`);
    process.exit(1);
  }

  return path.join(BINARIES_DIR, name);
}

export const isWindows = (): boolean => process.platform === 'win32';

// Packing replaces the Perl script with a real executable and drops lib/, so the
// shebang is what tells the two apart. Without this check a later `npm install`
// would treat the packed binary as missing and overwrite it with the script.
export function isPacked(): boolean {
  if (!fs.existsSync(hostSidecarPath())) return false;
  if (isWindows()) return true;

  const head = Buffer.alloc(2);
  const file = fs.openSync(hostSidecarPath(), 'r');
  try {
    fs.readSync(file, head, 0, 2, 0);
  } finally {
    fs.closeSync(file);
  }

  return head.toString() !== '#!';
}
