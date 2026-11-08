import { useState, useCallback, useEffect, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pictureDir } from "@tauri-apps/api/path";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "@fontsource-variable/public-sans";
import "@fontsource/zilla-slab/600.css";
import "@fontsource/zilla-slab/700.css";
import "./App.css";
import {
  Metadata, Reveal, baseName, copyName, fileKind, fileType, folderOf,
  formatSize, removableFields, reveals, summary,
} from "./metadata";

type SaveMode = 'copy' | 'overwrite';

interface FileItem {
  path: string;
  name: string;
  size: number;
  metadata?: Metadata;
  fields?: Array<[string, string]>;
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

interface ReadOutcome {
  file_path: string;
  info?: { file_size: number; metadata: Metadata; removable: string[] };
  error?: string;
}

const READ_BATCH = 25;

interface CleanResult {
  success: boolean;
  output_path: string;
  message: string;
}

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

// The color profile is not counted as personal metadata, but the settings decide
// whether it goes, so it is listed with what will be removed. HEIC cannot drop it,
// and in a PDF it belongs to the page content.
const fieldsToRemove = (file: FileItem, keep: PreservationOptions): Array<[string, string]> => {
  const fields = (file.fields ?? []).filter(([key]) => !(keep.orientation && key === 'Orientation'));
  const profile = file.metadata?.ProfileDescription ?? file.metadata?.ProfileName;
  if (profile && !keep.colorProfile && !['HEIC', 'PDF'].includes(file.metadata?.FileType ?? '')) fields.push(['ICC_Profile', profile]);
  return fields;
};

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
  const [version, setVersion] = useState('');
  const [updatesSupported, setUpdatesSupported] = useState(false);
  const [preservationOptions, setPreservationOptions] = useState<PreservationOptions>(() =>
    loadJson('preservationOptions', { orientation: false, colorProfile: false, modificationDate: false }));
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(() =>
    loadJson<{ autoUpdate: boolean | null }>('appSettings', { autoUpdate: null }).autoUpdate);
  const [saveMode, setSaveMode] = useState<SaveMode>(() =>
    localStorage.getItem('saveMode') === 'overwrite' ? 'overwrite' : 'copy');
  const askUpdates = updatesSupported && autoUpdate === null;

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
    getVersion().then(setVersion).catch((error) => console.error('Failed to read the version:', error));
    invoke<boolean>("updates_supported").then(setUpdatesSupported);
  }, []);

  useEffect(() => {
    if (!autoUpdate || !updatesSupported) return;
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
  }, [autoUpdate, updatesSupported]);

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

      for (let start = 0; start < expanded.length; start += READ_BATCH) {
        const batch = expanded.slice(start, start + READ_BATCH);
        try {
          const outcomes = await invoke<ReadOutcome[]>("read_files_metadata", { filePaths: batch });
          for (const { file_path, info, error } of outcomes) {
            updateFile(file_path, info
              ? { metadata: info.metadata, fields: removableFields(info.metadata, info.removable), size: info.file_size, loading: false }
              : { readError: error, loading: false });
          }
        } catch (error) {
          console.error("Failed to read metadata:", error);
          batch.forEach((path) => updateFile(path, { readError: String(error), loading: false }));
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

  // Without a starting folder Windows opens the folder the app was launched from,
  // which is its install folder.
  const browseFiles = async () => {
    const last = files[files.length - 1]?.path.replace(/[\\/][^\\/]*$/, '');
    const selected = await open({ multiple: true, defaultPath: last ?? await pictureDir().catch(() => undefined) });
    if (selected) handleFiles(Array.isArray(selected) ? selected : [selected]);
  };

  const clearFiles = () => {
    setFiles([]);
    setSelectedPath(null);
  };

  const removeFile = (path: string) => {
    const index = files.findIndex((f) => f.path === path);
    const rest = files.filter((f) => f.path !== path);
    setFiles((prev) => prev.filter((f) => f.path !== path));
    if (selectedPath === path) setSelectedPath(rest[Math.min(index, rest.length - 1)]?.path ?? null);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (!selectedPath || processing || showSettings || askUpdates) return;
      if (event.target instanceof HTMLInputElement) return;
      event.preventDefault();
      removeFile(selectedPath);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selected = files.find((f) => f.path === selectedPath) ?? null;
  const remaining = files.filter((f) => f.status !== 'cleaned' && !f.readError);
  const remainingFields = remaining.reduce((sum, f) => sum + fieldsToRemove(f, preservationOptions).length, 0);

  return (
    <div className="app">
      <header className="top-bar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 20 20" aria-hidden="true">
            <rect x="1.9" y="1" width="16.2" height="4.7" fill="currentColor" />
            <rect x="1.9" y="7.66" width="11.7" height="4.7" fill="#FFE14D" />
            <rect x="1.9" y="14.3" width="13.5" height="4.7" fill="currentColor" />
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
                <span className="note">A typical phone photo</span>
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
          <p className="formats">JPG, HEIC, PNG, TIFF, RAW, MP4, MOV, PDF and 80 more formats</p>
        </main>
      ) : (
        <main className={`workspace ${dragActive ? 'drag-active' : ''}`}>
          <aside className="file-list">
            <div className="file-list-head">
              <span className="file-count">{plural(files.length, 'file')}</span>
              {remaining.length > 0
                ? <span className="note">{plural(remainingFields, 'field')}</span>
                : <span className="note">0 fields left</span>}
              <button className="btn" onClick={browseFiles}>Add files</button>
            </div>

            <div className="file-rows">
              {files.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  selected={file.path === selectedPath}
                  count={fieldsToRemove(file, preservationOptions).length}
                  removable={!processing}
                  onSelect={() => setSelectedPath(file.path)}
                  onRemove={() => removeFile(file.path)}
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
                  <p className="caption">
                    {saveMode === 'copy'
                      ? <>Copies are saved as <strong>name_metadatazero.jpg</strong></>
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
                fields={fieldsToRemove(selected, preservationOptions)}
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
          autoUpdate={updatesSupported ? autoUpdate === true : null}
          onAutoUpdate={setAutoUpdate}
          exampleName={copyName(selected?.name ?? 'name.jpg')}
          version={version}
          onClose={() => setShowSettings(false)}
        />
      )}

      {askUpdates && (
        <div className="scrim centered">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="consent-title">
            <h2 id="consent-title">Check for updates automatically?</h2>
            <p className="dialog-text">Checks for a new version when the app starts. Nothing about your files is sent.</p>
            <div className="dialog-buttons">
              <button className="btn btn-large" onClick={() => setAutoUpdate(false)}>Don't check</button>
              <button className="btn-primary" onClick={() => setAutoUpdate(true)}>Check automatically</button>
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

function FileRow({ file, selected, count, removable, onSelect, onRemove }: {
  file: FileItem;
  selected: boolean;
  count: number;
  removable: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const cleaned = file.status === 'cleaned';
  const busy = file.loading || file.status === 'processing';

  let detail: ReactNode;
  if (cleaned) {
    detail = file.savedAs === 'overwrite' ? 'Original replaced' : 'Copy saved';
  } else if (file.readError) {
    detail = <span className="error">Can't read this file</span>;
  } else if (file.status === 'failed') {
    detail = <span className="error">Couldn't remove metadata</span>;
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
    <div className={`file-row ${selected ? 'selected' : ''}`}>
      <button className="file-row-main" onClick={onSelect}>
        <span className="file-text">
          <span className="file-name">{file.name}</span>
          <span className="file-detail">{detail}</span>
        </span>
        <span className="field-count">
          {busy ? '…' : cleaned ? '0' : file.metadata ? count : ''}
        </span>
      </button>
      <button
        className="file-remove"
        aria-label={`Remove ${file.name} from the list`}
        title="Remove from list"
        disabled={!removable}
        onClick={onRemove}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 2L10 10M10 2L2 10" />
        </svg>
      </button>
    </div>
  );
}

function FileDetail({ file, fields, processing, onClean }: {
  file: FileItem;
  fields: Array<[string, string]>;
  processing: boolean;
  onClean: () => void;
}) {
  const cleaned = file.status === 'cleaned';
  const found: Reveal[] = file.metadata ? reveals(file.metadata) : [];

  const subtitle = cleaned
    ? file.savedAs === 'overwrite' ? 'Original replaced' : `Saved as ${baseName(file.savedTo ?? '')}`
    : [fileType(file.metadata, file.name), file.size ? formatSize(file.size) : '', folderOf(file.path)].filter(Boolean).join(' · ');

  const kept = file.kept ?? [];

  return (
    <div className="detail-inner">
      <div className="detail-head">
        <div className="detail-title">
          <h2>{file.name}</h2>
          <p className="note">{subtitle}</p>
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
        <p className="detail-message error">{file.readError}</p>
      ) : (
        <>
          <div className="counter">
            <span className="counter-number">{cleaned ? 0 : fields.length}</span>
            <span className="counter-label">
              {cleaned
                ? kept.length > 0 ? <>metadata fields left<br />besides what you kept</> : 'metadata fields left'
                : <>metadata fields<br />in this {fileKind(file.metadata)}</>}
            </span>
          </div>

          {file.status === 'failed' && <p className="detail-message error">{file.cleanError}</p>}

          {found.length > 0 && (
            <section className="section">
              <h3 className="heading">{cleaned ? 'Removed' : 'What it reveals'}</h3>
              <div className="reveal-rows">
                {found.map((item, index) => (
                  <div className="reveal-row" key={item.label}>
                    <span className="row-label">{item.label}</span>
                    {cleaned ? (
                      <span className="reveal-value">
                        <span className="redacted" aria-hidden="true" style={{ animationDelay: `${index * 90}ms` }}>{item.value}</span>
                        <span className="visually-hidden">Removed</span>
                      </span>
                    ) : (
                      <span className="reveal-value">
                        <span className={item.leak ? 'leak' : ''}>{item.value}</span>
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
              <h3 className="heading">Kept</h3>
              <p className="kept">
                {kept.length === 0
                  ? 'Nothing. Choose what to keep, like orientation or color profile, in Settings.'
                  : `${kept.join(', ').replace(/^./, (c) => c.toUpperCase())}.`}
              </p>
            </section>
          ) : fields.length > 0 && (
            <section className="section">
              <h3 className="heading">All {fields.length} fields</h3>
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
  preservation, onPreservation, saveMode, onSaveMode, autoUpdate, onAutoUpdate, exampleName, version, onClose,
}: {
  preservation: PreservationOptions;
  onPreservation: (options: PreservationOptions) => void;
  saveMode: SaveMode;
  onSaveMode: (mode: SaveMode) => void;
  autoUpdate: boolean | null;
  onAutoUpdate: (on: boolean) => void;
  exampleName: string;
  version: string;
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

        <h3 className="heading sheet-section">When removing metadata, keep</h3>
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

        <h3 className="heading sheet-section">Saving</h3>
        {([
          ['copy', 'Keep the original, save a copy', <span className="example">{exampleName}</span>],
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

        {autoUpdate !== null && (
          <>
            <h3 className="heading sheet-section">Updates</h3>
            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-title">Check for updates automatically</span>
                <span className="setting-description">
                  Checks for a new version when the app starts. Nothing about your files is sent.
                </span>
              </div>
              <Toggle label="Check for updates automatically" on={autoUpdate} onChange={onAutoUpdate} />
            </div>
          </>
        )}

        <p className="sheet-foot">
          MetadataZero {version}
        </p>
      </div>
    </div>
  );
}

export default App;
