import { useState, useCallback, useEffect, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/martian-mono";
import "./App.css";
import {
  Metadata, Reveal, baseName, copyName, fieldCount, fileKind, fileType, folderOf,
  formatSize, reveals, summary, visibleFields,
} from "./metadata";

type SaveMode = 'copy' | 'overwrite';

interface FileItem {
  path: string;
  name: string;
  size: number;
  metadata?: Metadata;
  loading: boolean;
  readError?: string;
  status: 'pending' | 'processing' | 'cleaned' | 'failed';
  cleanError?: string;
  savedTo?: string;
  savedAs?: SaveMode;
  kept?: string[];
}

interface PreservationOptions {
  orientation: boolean;
  colorProfile: boolean;
  modificationDate: boolean;
}

interface CleanResult {
  success: boolean;
  output_path: string;
  message: string;
}

const THUMBNAIL_COLORS = ['#B8C4D9', '#C9C2D6', '#D3CBBE', '#E2E4E8'];

const userAgent = navigator.userAgent;
const FILE_MANAGER = /Mac/.test(userAgent) ? 'Finder' : /Windows/.test(userAgent) ? 'File Explorer' : 'your file manager';
const SHOW_IN = /Mac/.test(userAgent) ? 'Show in Finder' : /Windows/.test(userAgent) ? 'Show in Explorer' : 'Show in folder';

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const saved = localStorage.getItem(key);
    return saved ? { ...fallback, ...JSON.parse(saved) } : fallback;
  } catch {
    return fallback;
  }
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const keptLabels = (options: PreservationOptions): string[] => [
  options.orientation && 'orientation',
  options.colorProfile && 'color profile',
  options.modificationDate && 'modification date',
].filter(Boolean) as string[];

function App() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'none' | 'downloading' | 'ready'>('none');
  const [versions, setVersions] = useState({ app: '', exiftool: '' });
  const [preservationOptions, setPreservationOptions] = useState<PreservationOptions>(() =>
    loadJson('preservationOptions', { orientation: false, colorProfile: false, modificationDate: false }));
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(() =>
    loadJson<{ autoUpdate: boolean | null }>('appSettings', { autoUpdate: null }).autoUpdate);
  const [saveMode, setSaveMode] = useState<SaveMode>(() =>
    localStorage.getItem('saveMode') === 'overwrite' ? 'overwrite' : 'copy');

  useEffect(() => {
    localStorage.setItem('preservationOptions', JSON.stringify(preservationOptions));
  }, [preservationOptions]);

  useEffect(() => {
    localStorage.setItem('appSettings', JSON.stringify({ autoUpdate }));
  }, [autoUpdate]);

  useEffect(() => {
    localStorage.setItem('saveMode', saveMode);
  }, [saveMode]);

  useEffect(() => {
    Promise.all([getVersion(), invoke<string>("exiftool_version")])
      .then(([app, exiftool]) => setVersions({ app, exiftool }))
      .catch((error) => console.error('Failed to read versions:', error));
  }, []);

  useEffect(() => {
    if (!autoUpdate) return;
    (async () => {
      try {
        const update = await check();
        if (update) {
          setUpdateStatus('downloading');
          await update.downloadAndInstall();
          setUpdateStatus('ready');
        }
      } catch (error) {
        console.error('Failed to check for updates:', error);
        setUpdateStatus('none');
      }
    })();
  }, [autoUpdate]);

  const restartNow = async () => {
    try {
      await relaunch();
    } catch (error) {
      console.error('Failed to restart:', error);
      alert(`Failed to restart: ${error}\n\nPlease close and reopen the app manually to apply the update.`);
    }
  };

  const updateFile = (path: string, change: Partial<FileItem>) =>
    setFiles((prev) => prev.map((f) => (f.path === path ? { ...f, ...change } : f)));

  const handleFiles = useCallback(async (paths: string[]) => {
    try {
      const expanded = await invoke<string[]>("expand_paths", { paths });
      setFiles((prev) => {
        const known = new Set(prev.map((f) => f.path));
        const added = expanded
          .filter((path) => !known.has(path))
          .map((path): FileItem => ({ path, name: baseName(path), size: 0, loading: true, status: 'pending' }));
        return [...prev, ...added];
      });
      setSelectedPath((current) => current ?? expanded[0] ?? null);

      for (const path of expanded) {
        try {
          const info = await invoke<{ file_size: number; metadata: Metadata }>("read_file_metadata", { filePath: path });
          updateFile(path, { metadata: info.metadata, size: info.file_size, loading: false });
        } catch (error) {
          console.error("Failed to read metadata:", error);
          updateFile(path, { readError: String(error), loading: false });
        }
      }
    } catch (error) {
      console.error("Failed to expand paths:", error);
    }
  }, []);

  useEffect(() => {
    const unlistenDrop = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === 'over' || event.payload.type === 'enter') {
        setDragActive(true);
      } else if (event.payload.type === 'drop') {
        setDragActive(false);
        handleFiles(event.payload.paths);
      } else {
        setDragActive(false);
      }
    });
    const unlistenSettings = listen("open-settings", () => setShowSettings(true));
    const openPending = () =>
      invoke<string[]>("take_pending_files").then((paths) => { if (paths.length > 0) handleFiles(paths); });
    const unlistenOpen = listen("open-files", openPending);
    openPending();
    return () => {
      unlistenDrop.then((unlisten) => unlisten());
      unlistenSettings.then((unlisten) => unlisten());
      unlistenOpen.then((unlisten) => unlisten());
    };
  }, [handleFiles]);

  const cleanFiles = async (targets: FileItem[]) => {
    setProcessing(true);
    for (const file of targets) {
      updateFile(file.path, { status: 'processing', cleanError: undefined });
      try {
        const result = await invoke<CleanResult>("clean_file_metadata", {
          filePath: file.path,
          overwrite: saveMode === 'overwrite',
          preserveOrientation: preservationOptions.orientation,
          preserveColorProfile: preservationOptions.colorProfile,
          preserveModificationDate: preservationOptions.modificationDate,
        });
        updateFile(file.path, result.success
          ? { status: 'cleaned', savedTo: result.output_path, savedAs: saveMode, kept: keptLabels(preservationOptions) }
          : { status: 'failed', cleanError: result.message.trim() });
      } catch (error) {
        console.error(`Failed to clean ${file.name}:`, error);
        updateFile(file.path, { status: 'failed', cleanError: String(error) });
      }
    }
    setProcessing(false);
  };

  const browseFiles = async () => {
    const selected = await open({ multiple: true });
    if (selected) handleFiles(Array.isArray(selected) ? selected : [selected]);
  };

  const clearFiles = () => {
    setFiles([]);
    setSelectedPath(null);
  };

  const selected = files.find((f) => f.path === selectedPath) ?? null;
  const remaining = files.filter((f) => f.status !== 'cleaned' && !f.readError);
  const remainingFields = remaining.reduce((sum, f) => sum + (f.metadata ? fieldCount(f.metadata) : 0), 0);

  return (
    <div className="app">
      <header className="top-bar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 1024 1024" aria-hidden="true">
            <rect x="32" y="32" width="960" height="960" rx="176" fill="#2F3BFF" />
            <path d="M302.3 162.5H616.9L768.3 313.9V814.9Q768.3 861.5 721.7 861.5H302.3Q255.7 861.5 255.7 814.9V209.1Q255.7 162.5 302.3 162.5Z" fill="#FFFFFF" />
            <path d="M616.9 162.5V267.3Q616.9 313.9 663.5 313.9H768.3Z" fill="#C9CCFF" />
            <rect x="407.1" y="407.1" width="209.7" height="349.5" rx="104.9" fill="none" stroke="#2F3BFF" strokeWidth="60.6" />
            <line x1="432.3" y1="690.3" x2="591.7" y2="473.6" stroke="#2F3BFF" strokeWidth="55.7" strokeLinecap="round" />
          </svg>
          <span className="brand-name">MetadataZero</span>
        </div>
        <div className="top-actions">
          <div className="segmented" role="radiogroup" aria-label="Save mode">
            {(['copy', 'overwrite'] as const).map((mode) => (
              <button
                key={mode}
                role="radio"
                aria-checked={saveMode === mode}
                className={saveMode === mode ? 'selected' : ''}
                onClick={() => setSaveMode(mode)}
              >
                {mode === 'copy' ? 'Keep originals' : 'Replace originals'}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setShowSettings(true)}>Settings</button>
        </div>
      </header>

      {files.length === 0 ? (
        <main className={`empty ${dragActive ? 'drag-active' : ''}`}>
          <div className="empty-content">
            <h1>Drop photos, videos or PDFs</h1>
            <p className="empty-lead">
              See what they reveal about you, then remove it.<br />
              Files are processed on this computer and never uploaded.
            </p>
            <button className="btn-primary empty-choose" onClick={browseFiles}>Choose files</button>
            <div className="specimen">
              <div className="specimen-head">
                <span className="eyebrow">A typical phone photo</span>
                <span className="specimen-count">45 fields</span>
              </div>
              {[
                ['Location', '48.8584° N, 2.2945° E', true],
                ['Taken', '12 Oct 2026, 14:32', false],
                ['Device', 'Apple iPhone 15 Pro', false],
                ['Software', 'iOS 18.1', false],
              ].map(([label, value, leak]) => (
                <div className="specimen-row" key={label as string}>
                  <span className="row-label">{label}</span>
                  <span className={leak ? 'leak' : ''}>{value}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="formats">JPG  HEIC  PNG  TIFF  RAW  MP4  MOV  PDF  and 80 more</p>
        </main>
      ) : (
        <main className={`workspace ${dragActive ? 'drag-active' : ''}`}>
          <aside className="file-list">
            <div className="file-list-head">
              <span className="file-count">{plural(files.length, 'file')}</span>
              {remaining.length > 0
                ? <span className="mono-note">{plural(remainingFields, 'field')}</span>
                : <span className="mono-note marker">0 fields left</span>}
              <button className="btn" onClick={browseFiles}>Add files</button>
            </div>

            <div className="file-rows">
              {files.map((file, index) => (
                <FileRow
                  key={file.path}
                  file={file}
                  color={THUMBNAIL_COLORS[index % THUMBNAIL_COLORS.length]}
                  selected={file.path === selectedPath}
                  onSelect={() => setSelectedPath(file.path)}
                />
              ))}
            </div>

            <div className="file-list-foot">
              {remaining.length > 0 ? (
                <>
                  <button
                    className="btn-primary"
                    disabled={processing || remaining.some((f) => f.loading)}
                    onClick={() => cleanFiles(remaining)}
                  >
                    {processing ? 'Removing metadata…' : `Remove metadata from ${plural(remaining.length, 'file')}`}
                  </button>
                  <p className="mono-caption">
                    {saveMode === 'copy'
                      ? <>Copies are saved as{'  '}<span className="ink">name_metadatazero.jpg</span></>
                      : 'Originals are replaced'}
                  </p>
                </>
              ) : (
                <button className="btn btn-large" onClick={clearFiles}>Clear list</button>
              )}
            </div>
          </aside>

          <section className="detail">
            {selected && (
              <FileDetail
                file={selected}
                processing={processing}
                onClean={() => cleanFiles([selected])}
              />
            )}
          </section>
        </main>
      )}

      {showSettings && (
        <SettingsSheet
          preservation={preservationOptions}
          onPreservation={setPreservationOptions}
          saveMode={saveMode}
          onSaveMode={setSaveMode}
          autoUpdate={autoUpdate === true}
          onAutoUpdate={setAutoUpdate}
          exampleName={copyName(selected?.name ?? 'name.jpg')}
          versions={versions}
          onClose={() => setShowSettings(false)}
        />
      )}

      {autoUpdate === null && (
        <div className="scrim centered">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title">
            <h2 id="consent-title">Check for updates automatically?</h2>
            <p className="dialog-text">
              MetadataZero can check github.com for a new version each time it starts.
              GitHub sees your IP address. Nothing about your files is sent.
            </p>
            <p className="dialog-hint">You can change this later in Settings.</p>
            <div className="dialog-buttons">
              <button className="btn btn-large" onClick={() => setAutoUpdate(false)}>Don't check</button>
              <button className="btn btn-large" onClick={() => setAutoUpdate(true)}>Check automatically</button>
            </div>
          </div>
        </div>
      )}

      {updateStatus === 'downloading' && (
        <div className="toast">Downloading update…</div>
      )}

      {updateStatus === 'ready' && (
        <div className="toast">
          Update ready
          <button className="btn" onClick={restartNow}>Restart now</button>
        </div>
      )}
    </div>
  );
}

function FileRow({ file, color, selected, onSelect }: {
  file: FileItem;
  color: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const cleaned = file.status === 'cleaned';
  const busy = file.loading || file.status === 'processing';

  let detail: ReactNode;
  if (cleaned) {
    detail = file.savedAs === 'overwrite' ? 'Original replaced' : 'Copy saved';
  } else if (file.readError) {
    detail = <span className="leak">Can't read this file</span>;
  } else if (file.status === 'failed') {
    detail = <span className="leak">Couldn't remove metadata</span>;
  } else {
    const items = file.metadata ? summary(file.metadata) : [];
    detail = (
      <>
        {formatSize(file.size)}
        {items.map((item) => (
          <span key={item.label}>
            {' · '}
            <span className={item.leak ? 'leak' : ''}>{item.summary}</span>
          </span>
        ))}
      </>
    );
  }

  return (
    <button className={`file-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className="thumbnail" style={{ background: color }} />
      <span className="file-text">
        <span className="file-name">{file.name}</span>
        <span className="file-detail">{detail}</span>
      </span>
      <span className={`field-count ${cleaned ? 'marker' : ''}`}>
        {busy ? '…' : cleaned ? '0' : file.metadata ? fieldCount(file.metadata) : ''}
      </span>
    </button>
  );
}

function FileDetail({ file, processing, onClean }: {
  file: FileItem;
  processing: boolean;
  onClean: () => void;
}) {
  const cleaned = file.status === 'cleaned';
  const found: Reveal[] = file.metadata ? reveals(file.metadata) : [];
  const fields = file.metadata ? visibleFields(file.metadata) : [];

  const subtitle = cleaned
    ? file.savedAs === 'overwrite' ? 'Original replaced' : `Saved as ${baseName(file.savedTo ?? '')}`
    : [fileType(file.metadata, file.name), file.size ? formatSize(file.size) : '', folderOf(file.path)].filter(Boolean).join(' · ');

  const kept = file.kept ?? [];

  return (
    <div className="detail-inner">
      <div className="detail-head">
        <div className="detail-title">
          <h2>{file.name}</h2>
          <p className="mono-note">{subtitle}</p>
        </div>
        {cleaned ? (
          <button className="btn btn-medium" onClick={() => revealItemInDir(file.savedTo ?? file.path)}>{SHOW_IN}</button>
        ) : (
          <button
            className="btn btn-medium"
            disabled={processing || file.loading || !!file.readError}
            onClick={onClean}
          >
            Remove from this file
          </button>
        )}
      </div>

      {file.loading ? (
        <p className="detail-message">Reading metadata…</p>
      ) : file.readError ? (
        <p className="detail-message leak">{file.readError}</p>
      ) : (
        <>
          <div className="counter">
            <span className={`counter-number ${cleaned ? 'marker' : ''}`}>{cleaned ? 0 : fields.length}</span>
            <span className="counter-label">
              {cleaned ? 'metadata fields left' : <>metadata fields<br />in this {fileKind(file.metadata)}</>}
            </span>
          </div>

          {file.status === 'failed' && <p className="detail-message leak">{file.cleanError}</p>}

          {found.length > 0 && (
            <section className="section">
              <h3 className="eyebrow">{cleaned ? 'Removed' : 'What it reveals'}</h3>
              <div className="reveal-rows">
                {found.map((item) => (
                  <div className="reveal-row" key={item.label}>
                    <span className="row-label">{item.label}</span>
                    {cleaned ? (
                      <span className="redaction" style={{ width: `${Math.min(item.value.length, 48) * 0.52}em` }} />
                    ) : (
                      <span className={`reveal-value ${item.leak ? 'leak' : ''}`}>
                        {item.label === 'Location' && <span className="leak-dot" />}
                        {item.value}
                      </span>
                    )}
                    <span className="reveal-source">{item.source}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {cleaned ? (
            <section className="section">
              <h3 className="eyebrow">Kept</h3>
              <p className="kept">
                {kept.length === 0
                  ? 'Nothing. Choose what to keep, like orientation or color profile, in Settings.'
                  : `${kept.join(', ').replace(/^./, (c) => c.toUpperCase())}.`}
              </p>
            </section>
          ) : fields.length > 0 && (
            <section className="section">
              <h3 className="eyebrow">All {fields.length} fields</h3>
              <div className="field-grid">
                {fields.map(([key, value]) => (
                  <div className="field" key={key}>
                    <span className="field-key">{key}</span>
                    <span className="field-value">{value}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="knob" />
    </button>
  );
}

function SettingsSheet({
  preservation, onPreservation, saveMode, onSaveMode, autoUpdate, onAutoUpdate, exampleName, versions, onClose,
}: {
  preservation: PreservationOptions;
  onPreservation: (options: PreservationOptions) => void;
  saveMode: SaveMode;
  onSaveMode: (mode: SaveMode) => void;
  autoUpdate: boolean;
  onAutoUpdate: (on: boolean) => void;
  exampleName: string;
  versions: { app: string; exiftool: string };
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const keepRows: Array<[keyof PreservationOptions, string, string]> = [
    ['orientation', 'Orientation', 'Photos stay the right way up. Reveals nothing about you.'],
    ['colorProfile', 'Color profile', 'Colors look exactly like the original.'],
    ['modificationDate', 'Modification date', `The date shown in ${FILE_MANAGER}. It can reveal when you worked on the file.`],
  ];

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 id="settings-title">Settings</h2>
          <button className="btn btn-done" onClick={onClose}>Done</button>
        </div>

        <h3 className="eyebrow sheet-section">When removing metadata, keep</h3>
        {keepRows.map(([key, title, description]) => (
          <div className="setting-row" key={key}>
            <div className="setting-text">
              <span className="setting-title">{title}</span>
              <span className="setting-description">{description}</span>
            </div>
            <Toggle
              label={title}
              on={preservation[key]}
              onChange={(on) => onPreservation({ ...preservation, [key]: on })}
            />
          </div>
        ))}

        <h3 className="eyebrow sheet-section">Saving</h3>
        {([
          ['copy', 'Keep the original, save a copy', <span className="mono-example">{exampleName}</span>],
          ['overwrite', 'Replace the original', "The original metadata can't be recovered."],
        ] as const).map(([mode, title, description]) => (
          <label className="setting-row radio-row" key={mode}>
            <input
              type="radio"
              name="save-mode"
              checked={saveMode === mode}
              onChange={() => onSaveMode(mode)}
            />
            <span className="setting-text">
              <span className="setting-title">{title}</span>
              <span className="setting-description">{description}</span>
            </span>
          </label>
        ))}

        <h3 className="eyebrow sheet-section">Updates</h3>
        <div className="setting-row">
          <div className="setting-text">
            <span className="setting-title">Check for updates automatically</span>
            <span className="setting-description">
              Connects to github.com when the app starts. Nothing about your files is sent.
            </span>
          </div>
          <Toggle label="Check for updates automatically" on={autoUpdate} onChange={onAutoUpdate} />
        </div>

        <p className="sheet-foot">
          MetadataZero {versions.app}{versions.exiftool && ` · ExifTool ${versions.exiftool}`}
        </p>
      </div>
    </div>
  );
}

export default App;
