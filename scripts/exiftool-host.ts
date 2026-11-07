import fs from 'node:fs';
import path from 'node:path';

export const EXIFTOOL_VERSION = '13.55';
export const EXIFTOOL_SHA256 = '5c9d422ad128fab728aacc5cc0aa77095d14cde74931389dd961d3d720e6b316';
export const EXIFTOOL_WINDOWS_SHA256 = '9fadaf5221dcb07a5d018e21c8529e257917d2fad1fdfc8e64855c4fb73293df';

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
