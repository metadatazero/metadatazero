import fs from 'node:fs';
import path from 'node:path';

export const TOOLS_FILE = path.join(import.meta.dirname, '..', 'tools.json');

export interface Tool {
  version: string;
  sha256: Record<string, string>;
}

export interface Tools {
  exiftool: Tool;
  qpdf: Tool;
}

export const readTools = (): Tools => JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));

export const writeTools = (tools: Tools): void =>
  fs.writeFileSync(TOOLS_FILE, `${JSON.stringify(tools, null, 2)}\n`);

export const exiftoolUrls = (version: string) => ({
  'macos-linux': `https://github.com/exiftool/exiftool/archive/refs/tags/${version}.tar.gz`,
  windows: `https://sourceforge.net/projects/exiftool/files/exiftool-${version}_64.zip/download`,
});

export const QPDF_ASSETS: Record<string, string> = {
  'darwin-arm64': 'bin-macos-arm64',
  'darwin-x64': 'bin-macos-x86_64',
  'linux-x64': 'bin-linux-x86_64',
  'linux-arm64': 'bin-linux-aarch64',
  'win32-x64': 'msvc64',
};

export const qpdfUrl = (version: string, asset: string): string =>
  `https://github.com/qpdf/qpdf/releases/download/v${version}/qpdf-${version}-${asset}.zip`;
