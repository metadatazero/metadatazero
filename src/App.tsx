import { useState, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

interface FileWithMetadata {
  path: string;
  name: string;
  size: number;
  metadata?: Record<string, string>;
  cleaned?: boolean;
  processing?: boolean;
  metadataError?: string;
  metadataLoading?: boolean;
}

interface MetadataGroup {
  name: string;
  items: Array<{ key: string; value: string }>;
}

const HIDDEN_KEYS = [
  'SourceFile', 'ExifToolVersion', 'FileName', 'Directory',
  'FilePermissions', 'FileModifyDate', 'FileAccessDate',
  'FileInodeChangeDate', 'FileSize', 'FileType', 'FileTypeExtension',
  'MIMEType'
];

const formatMetadataValue = (value: string): string => {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }

  if (value.match(/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}/)) {
    const date = value.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    try {
      return new Date(date).toLocaleString();
    } catch {
      return value;
    }
  }
  return value;
};

const groupMetadata = (metadata: Record<string, string>): MetadataGroup[] => {
  const filtered = Object.entries(metadata).filter(
    ([key]) => !HIDDEN_KEYS.includes(key)
  );

  if (filtered.length === 0) return [];

  const groups: Record<string, Array<{ key: string; value: string }>> = {
    'Location': [],
    'Camera': [],
    'Image': [],
    'Other': []
  };

  filtered.forEach(([key, value]) => {
    const item = { key, value: formatMetadataValue(value) };

    if (key.includes('GPS') || key.includes('Location')) {
      groups['Location'].push(item);
    } else if (key.includes('Camera') || key.includes('Make') || key.includes('Model') || key.includes('Lens')) {
      groups['Camera'].push(item);
    } else if (key.includes('Width') || key.includes('Height') || key.includes('Resolution') || key.includes('ColorSpace')) {
      groups['Image'].push(item);
    } else {
      groups['Other'].push(item);
    }
  });

  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({ name, items }));
};

interface PreservationOptions {
  orientation: boolean;
  colorProfile: boolean;
  modificationDate: boolean;
}

interface AppSettings {
  autoUpdate: boolean;
}

function App() {
  const [files, setFiles] = useState<FileWithMetadata[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileWithMetadata | null>(null);
  const [processing, setProcessing] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<'none' | 'downloading' | 'ready'>('none');
  const [preservationOptions, setPreservationOptions] = useState<PreservationOptions>(() => {
    const saved = localStorage.getItem('preservationOptions');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return {
          orientation: false,
          colorProfile: false,
          modificationDate: false,
        };
      }
    }
    return {
      orientation: false,
      colorProfile: false,
      modificationDate: false,
    };
  });

  const [appSettings, setAppSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem('appSettings');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return {
          autoUpdate: true,
        };
      }
    }
    return {
      autoUpdate: true,
    };
  });

  useEffect(() => {
    localStorage.setItem('preservationOptions', JSON.stringify(preservationOptions));
  }, [preservationOptions]);

  useEffect(() => {
    localStorage.setItem('appSettings', JSON.stringify(appSettings));
  }, [appSettings]);

  useEffect(() => {
    const checkForUpdates = async () => {
      if (!appSettings.autoUpdate) return;

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
    };

    checkForUpdates();
  }, [appSettings.autoUpdate]);

  const restartNow = async () => {
    try {
      await relaunch();
    } catch (error) {
      console.error('Failed to restart:', error);
      alert(`Failed to restart: ${error}\n\nPlease close and reopen the app manually to apply the update.`);
    }
  };

  useEffect(() => {
    const unlistenPromise = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === 'over') {
        setDragActive(true);
      } else if (event.payload.type === 'drop') {
        setDragActive(false);
        const paths = event.payload.paths as string[];
        handleFiles(paths);
      } else if (event.payload.type === 'leave') {
        setDragActive(false);
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen("open-settings", () => {
      setShowSettings(true);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleFiles = useCallback(async (paths: string[]) => {
    try {
      const expandedPaths = await invoke<string[]>("expand_paths", { paths });

      const newFiles: FileWithMetadata[] = expandedPaths.map((path) => ({
        path,
        name: path.split('/').pop() || path,
        size: 0,
        processing: false,
        metadataLoading: true,
      }));

      setFiles((prev) => [...prev, ...newFiles]);

      for (const file of newFiles) {
        try {
          const metadata = await invoke<{
            file_path: string;
            file_name: string;
            file_size: number;
            metadata: Record<string, string>;
          }>("read_file_metadata", { filePath: file.path });

          setFiles((prev) =>
            prev.map((f) =>
              f.path === file.path
                ? { ...f, metadata: metadata.metadata, size: metadata.file_size, metadataLoading: false }
                : f
            )
          );
        } catch (error) {
          console.error("Failed to read metadata:", error);
          setFiles((prev) =>
            prev.map((f) =>
              f.path === file.path
                ? { ...f, metadataError: String(error), metadataLoading: false }
                : f
            )
          );
        }
      }
    } catch (error) {
      console.error("Failed to expand paths:", error);
    }
  }, []);

  const cleanFile = async (filePath: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, processing: true } : f))
    );

    try {
      await invoke("clean_file_metadata", {
        filePath: filePath,
        backup: false,
        preserveOrientation: preservationOptions.orientation,
        preserveColorProfile: preservationOptions.colorProfile,
        preserveModificationDate: preservationOptions.modificationDate,
      });

      setFiles((prev) =>
        prev.map((f) =>
          f.path === filePath ? { ...f, cleaned: true, processing: false } : f
        )
      );
    } catch (error) {
      console.error("Failed to clean metadata:", error);
      setFiles((prev) =>
        prev.map((f) => (f.path === filePath ? { ...f, processing: false } : f))
      );
    }
  };

  const cleanAllFiles = async () => {
    setProcessing(true);
    const filesToClean = files.filter((f) => !f.cleaned);

    for (const file of filesToClean) {
      setFiles((prev) =>
        prev.map((f) => (f.path === file.path ? { ...f, processing: true } : f))
      );

      try {
        await invoke("clean_file_metadata", {
          filePath: file.path,
          backup: false,
          preserveOrientation: preservationOptions.orientation,
          preserveColorProfile: preservationOptions.colorProfile,
          preserveModificationDate: preservationOptions.modificationDate,
        });

        setFiles((prev) =>
          prev.map((f) =>
            f.path === file.path ? { ...f, cleaned: true, processing: false } : f
          )
        );
      } catch (error) {
        console.error(`Failed to clean ${file.name}:`, error);
        setFiles((prev) =>
          prev.map((f) => (f.path === file.path ? { ...f, processing: false } : f))
        );
      }
    }

    setProcessing(false);
  };

  const clearFiles = () => {
    setFiles([]);
    setSelectedFile(null);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-title-row">
          <h1>MetadataZero</h1>
        </div>
        <p>Remove metadata from your photos and documents</p>
      </header>

      <main className="main">
        {files.length === 0 ? (
          <div className={`drop-zone ${dragActive ? "active" : ""}`}>
            <div className="drop-zone-content">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <h2>Drop files here</h2>
              <p>Supports images, videos, and PDF files</p>
            </div>
          </div>
        ) : (
          <div className="content">
            <div className="file-list">
              <div className="file-list-header">
                <h3>{files.length} file(s)</h3>
                <div className="actions">
                  <button onClick={cleanAllFiles} disabled={processing} className="btn-primary">
                    {processing ? "Cleaning..." : "Clean All"}
                  </button>
                  <button onClick={clearFiles} className="btn-secondary">
                    Clear
                  </button>
                </div>
              </div>
              <div className="files">
                {files.map((file) => (
                  <div
                    key={file.path}
                    className={`file-item ${selectedFile?.path === file.path ? "selected" : ""} ${file.cleaned ? "cleaned" : ""}`}
                    onClick={() => setSelectedFile(file)}
                  >
                    <div className="file-info">
                      <div className="file-name">{file.name}</div>
                      <div className="file-size">{(file.size / 1024).toFixed(2)} KB</div>
                    </div>
                    {file.processing && <div className="spinner"></div>}
                    {file.cleaned && <span className="badge">Cleaned</span>}
                    {!file.cleaned && !file.processing && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          cleanFile(file.path);
                        }}
                        className="btn-clean"
                      >
                        Clean
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {selectedFile && (
              <div className="metadata-panel">
                <h3>Metadata</h3>
                {selectedFile.cleaned ? (
                  <p className="empty-state">All metadata has been removed</p>
                ) : selectedFile.metadataError ? (
                  <p className="empty-state error">Failed to load metadata: {selectedFile.metadataError}</p>
                ) : selectedFile.metadataLoading ? (
                  <p className="empty-state">Loading metadata...</p>
                ) : selectedFile.metadata && Object.keys(selectedFile.metadata).length > 0 ? (
                  <div className="metadata-list">
                    {groupMetadata(selectedFile.metadata).map((group) => (
                      <div key={group.name} className="metadata-group">
                        <div className="metadata-group-title">{group.name}</div>
                        {group.items.map(({ key, value }) => (
                          <div key={key} className="metadata-item">
                            <span className="metadata-key">{key}</span>
                            <span className="metadata-value">{value}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="empty-state">No metadata found</p>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Settings</h2>
              <button className="modal-close" onClick={() => setShowSettings(false)}>×</button>
            </div>
            <div className="modal-content">
              <h3 className="settings-section-title">Metadata Preservation</h3>
              <p className="modal-description">
                Choose what metadata to preserve during cleaning. By default, all metadata is removed.
              </p>
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={preservationOptions.orientation}
                    onChange={(e) =>
                      setPreservationOptions((prev) => ({
                        ...prev,
                        orientation: e.target.checked,
                      }))
                    }
                  />
                  <div className="checkbox-content">
                    <span className="checkbox-title">Preserve Orientation</span>
                    <span className="checkbox-description">
                      Keeps image orientation metadata to ensure images display correctly
                    </span>
                  </div>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={preservationOptions.colorProfile}
                    onChange={(e) =>
                      setPreservationOptions((prev) => ({
                        ...prev,
                        colorProfile: e.target.checked,
                      }))
                    }
                  />
                  <div className="checkbox-content">
                    <span className="checkbox-title">Preserve Color Profile</span>
                    <span className="checkbox-description">
                      Keeps color space and ICC profile information for accurate color display
                    </span>
                  </div>
                </label>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={preservationOptions.modificationDate}
                    onChange={(e) =>
                      setPreservationOptions((prev) => ({
                        ...prev,
                        modificationDate: e.target.checked,
                      }))
                    }
                  />
                  <div className="checkbox-content">
                    <span className="checkbox-title">Preserve Modification Date</span>
                    <span className="checkbox-description">
                      Keeps the file's last modified timestamp unchanged
                    </span>
                  </div>
                </label>
              </div>

              <h3 className="settings-section-title">Application Settings</h3>
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={appSettings.autoUpdate}
                    onChange={(e) =>
                      setAppSettings((prev) => ({
                        ...prev,
                        autoUpdate: e.target.checked,
                      }))
                    }
                  />
                  <div className="checkbox-content">
                    <span className="checkbox-title">Auto Update</span>
                    <span className="checkbox-description">
                      Automatically check for and install updates when available
                    </span>
                  </div>
                </label>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-primary" onClick={() => setShowSettings(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {updateStatus === 'downloading' && (
        <div className="update-toast">
          <span>⬇️ Downloading update...</span>
        </div>
      )}

      {updateStatus === 'ready' && (
        <div className="update-toast update-ready">
          <span>✅ Update ready!</span>
          <button onClick={restartNow} className="btn-restart">
            Restart Now
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
