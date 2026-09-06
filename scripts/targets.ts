import fs from 'node:fs';
import path from 'node:path';

interface Artifact {
  dir: string;
  ext: string;
}

export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')
).version;

const OS_NAMES = ['mac', 'linux', 'win'] as const;
const ARCH_NAMES = ['x64', 'arm64'] as const;

export type OsName = (typeof OS_NAMES)[number];
export type ArchName = (typeof ARCH_NAMES)[number];

export const LAYOUT: Record<OsName, Artifact[]> = {
  mac: [
    { dir: 'dmg', ext: '.dmg' },
    { dir: 'macos', ext: '.app.tar.gz' },
    { dir: 'macos', ext: '.app.tar.gz.sig' },
  ],
  linux: [
    { dir: 'appimage', ext: '.AppImage' },
    { dir: 'appimage', ext: '.AppImage.sig' },
    { dir: 'deb', ext: '.deb' },
    { dir: 'rpm', ext: '.rpm' },
    { dir: 'rpm', ext: '.rpm.sig' },
  ],
  win: [
    { dir: 'nsis', ext: '.exe' },
    { dir: 'nsis', ext: '.exe.sig' },
    { dir: 'msi', ext: '.msi' },
    { dir: 'msi', ext: '.msi.sig' },
  ],
};

const UPDATER: Record<OsName, Artifact & { rustOs: string }> = {
  mac: { dir: 'macos', ext: '.app.tar.gz', rustOs: 'darwin' },
  linux: { dir: 'appimage', ext: '.AppImage', rustOs: 'linux' },
  win: { dir: 'nsis', ext: '.exe', rustOs: 'windows' },
};

const RUST_ARCH: Record<ArchName, string> = { x64: 'x86_64', arm64: 'aarch64' };

const isOsName = (value?: string): value is OsName => OS_NAMES.includes(value as OsName);
const isArchName = (value?: string): value is ArchName => ARCH_NAMES.includes(value as ArchName);

export const artifactName = (os: OsName, arch: ArchName, ext: string): string =>
  `MetadataZero-${VERSION}-${os}-${arch}${ext}`;

export function updaterFor(os: OsName, arch: ArchName) {
  const { dir, ext, rustOs } = UPDATER[os];
  return {
    dir,
    platform: `${rustOs}-${RUST_ARCH[arch]}`,
    file: artifactName(os, arch, ext),
  };
}

export function parseArgs(): { bundleDir: string; os: OsName; arch: ArchName } {
  const [bundleDir, os, arch] = process.argv.slice(2);

  if (!bundleDir || !isOsName(os) || !isArchName(arch)) {
    const script = path.basename(process.argv[1]);
    console.error(`Usage: node scripts/${script} <bundleDir> <${OS_NAMES.join('|')}> <${ARCH_NAMES.join('|')}>`);
    console.error(`Example: node scripts/${script} src-tauri/target/release/bundle linux arm64`);
    process.exit(1);
  }

  return { bundleDir, os, arch };
}
