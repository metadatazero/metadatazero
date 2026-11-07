export type Metadata = Record<string, string>;

export interface Reveal {
  label: string;
  summary: string;
  value: string;
  source: string;
  leak: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const removableFields = (metadata: Metadata, removable: string[]): Array<[string, string]> =>
  removable.map((key) => [key, unquote(metadata[key] ?? '')]);

const unquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;

const first = (metadata: Metadata, keys: string[]): [string, string] | undefined => {
  const key = keys.find((k) => metadata[k]?.trim());
  return key ? [key, unquote(metadata[key])] : undefined;
};

const toDecimal = (dms: string): string => {
  const match = dms.match(/(\d+) deg (\d+)' ([\d.]+)" ([NSEW])/);
  if (!match) return dms;
  const [, deg, min, sec, hemisphere] = match;
  const decimal = Number(deg) + Number(min) / 60 + Number(sec) / 3600;
  return `${decimal.toFixed(4)}° ${hemisphere}`;
};

const formatPosition = (metadata: Metadata): string | undefined => {
  const position = metadata.GPSPosition
    ?? (metadata.GPSLatitude && metadata.GPSLongitude ? `${metadata.GPSLatitude}, ${metadata.GPSLongitude}` : undefined);
  if (!position) return undefined;
  const coordinates = position.split(',').map((part) => toDecimal(part.trim())).join(', ');
  const altitude = metadata.GPSAltitude?.match(/^(-?[\d.]+) m( Below)?/);
  if (!altitude) return coordinates;
  const meters = Math.round(Number(altitude[1])) * (altitude[2] ? -1 : 1);
  return `${coordinates} · ${meters} m`;
};

const formatDate = (value: string, offset?: string): string => {
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (!match) return value;
  const [, year, month, day, time] = match;
  const zone = offset ? ` UTC${offset}` : '';
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}, ${time}${zone}`;
};

export const reveals = (metadata: Metadata): Reveal[] => {
  const found: Reveal[] = [];

  const position = formatPosition(metadata);
  if (position) {
    found.push({ label: 'Location', summary: 'Location', value: position, source: 'GPSPosition', leak: true });
  }

  // In a PDF, Creator is the app that made the document, not a person.
  const isPdf = metadata.FileType === 'PDF';
  const nameKeys = ['Artist', 'Author', 'OwnerName', 'CameraOwnerName', 'XPAuthor', 'By-line', 'LastModifiedBy'];
  const name = first(metadata, isPdf ? nameKeys : [...nameKeys, 'Creator']);
  if (name) found.push({ label: 'Name', summary: 'Name', value: name[1], source: name[0], leak: true });

  const taken = first(metadata, ['DateTimeOriginal', 'CreateDate', 'MediaCreateDate', 'CreationDate']);
  if (taken) {
    const offset = taken[0] === 'DateTimeOriginal' ? metadata.OffsetTimeOriginal : undefined;
    found.push({ label: 'Taken', summary: 'time', value: formatDate(taken[1], offset), source: taken[0], leak: false });
  }

  const make = metadata.Make?.trim();
  const model = metadata.Model?.trim();
  if (make || model) {
    const device = make && model && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : (model ?? make)!;
    found.push({ label: 'Device', summary: 'device', value: device, source: make && model ? 'Make · Model' : make ? 'Make' : 'Model', leak: false });
  }

  const serial = first(metadata, ['SerialNumber', 'BodySerialNumber', 'InternalSerialNumber']);
  if (serial) found.push({ label: 'Serial', summary: 'camera serial', value: serial[1], source: serial[0], leak: false });

  const lens = first(metadata, ['LensModel', 'Lens']);
  if (lens) found.push({ label: 'Lens', summary: 'lens', value: lens[1], source: lens[0], leak: false });

  const software = first(metadata, isPdf ? ['Software', 'CreatorTool', 'Creator', 'Producer'] : ['Software', 'CreatorTool', 'Producer']);
  if (software) found.push({ label: 'Software', summary: 'software', value: software[1], source: software[0], leak: false });

  return found;
};

const SUMMARY_ORDER = ['Location', 'Name', 'Serial', 'Device', 'Taken', 'Software'];

export const summary = (metadata: Metadata): Reveal[] =>
  reveals(metadata)
    .filter((r) => SUMMARY_ORDER.includes(r.label))
    .sort((a, b) => SUMMARY_ORDER.indexOf(a.label) - SUMMARY_ORDER.indexOf(b.label))
    .slice(0, 3);

export const formatSize = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
};

export const baseName = (path: string): string => path.split(/[\\/]/).pop() || path;

export const folderOf = (path: string): string => {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join('/')
    .replace(/^\/(Users|home)\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\/Users\/[^/]+/, '~');
};

export const copyName = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? `${fileName.slice(0, dot)}_metadatazero${fileName.slice(dot)}` : `${fileName}_metadatazero`;
};

export const fileKind = (metadata: Metadata | undefined): string => {
  const mime = metadata?.MIMEType ?? '';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
};

export const fileType = (metadata: Metadata | undefined, fileName: string): string =>
  metadata?.FileType ?? fileName.split('.').pop()?.toUpperCase() ?? '';
