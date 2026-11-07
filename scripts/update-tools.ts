import crypto from 'node:crypto';
import { QPDF_ASSETS, exiftoolUrls, readTools, writeTools } from './tools.ts';

const HEADERS = { 'User-Agent': 'metadatazero-update-tools' };

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

async function sha256Of(url: string): Promise<string> {
  console.log(`  downloading ${url}`);
  const bytes = Buffer.from(await (await fetchOk(url)).arrayBuffer());
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// ExifTool tags development releases too, so the version is always chosen by hand
// from the production release shown on exiftool.org.
async function updateExiftool(version: string): Promise<Record<string, string>> {
  const urls = exiftoolUrls(version);
  return {
    'macos-linux': await sha256Of(urls['macos-linux']),
    windows: await sha256Of(urls.windows),
  };
}

async function latestQpdf(): Promise<string> {
  const release = (await (await fetchOk('https://api.github.com/repos/qpdf/qpdf/releases/latest')).json()) as { tag_name: string };
  return release.tag_name.replace(/^v/, '');
}

async function updateQpdf(version: string): Promise<Record<string, string>> {
  const sums = await (await fetchOk(`https://github.com/qpdf/qpdf/releases/download/v${version}/qpdf-${version}.sha256`)).text();
  const byFile = new Map(sums.trim().split('\n').map((line) => {
    const [hash, file] = line.trim().split(/\s+/);
    return [file, hash] as const;
  }));
  const sha256: Record<string, string> = {};
  for (const asset of Object.values(QPDF_ASSETS)) {
    const hash = byFile.get(`qpdf-${version}-${asset}.zip`);
    if (!hash) throw new Error(`QPDF ${version} publishes no checksum for ${asset}`);
    sha256[asset] = hash;
  }
  return sha256;
}

const [tool, requested] = process.argv.slice(2);

if ((tool !== 'exiftool' && tool !== 'qpdf') || (tool === 'exiftool' && !requested)) {
  console.error('Usage: npm run update-tools -- exiftool <version>');
  console.error('       npm run update-tools -- qpdf [version]   (latest release when omitted)');
  process.exit(1);
}

try {
  const tools = readTools();
  const version = tool === 'qpdf' && !requested ? await latestQpdf() : requested;
  console.log(`Updating ${tool} ${tools[tool].version} → ${version}`);
  const sha256 = tool === 'exiftool' ? await updateExiftool(version) : await updateQpdf(version);
  tools[tool] = { version, sha256 };
  writeTools(tools);
  console.log('✓ tools.json updated. Run npm install to download it.');
} catch (err) {
  console.error('Failed to update:', (err as Error).message);
  process.exit(1);
}
