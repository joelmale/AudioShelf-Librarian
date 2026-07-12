import { ArrowUp, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import React from "react";
import { loadServerDirectory } from "../settingsCapabilities.js";

interface ServerPathPickerProps {
  initialPath: string;
  label: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
}

function joinPath(parent: string, child: string) {
  if (parent === "/") return `/${child}`;
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child}`;
}

export function ServerPathPicker({ initialPath, label, onCancel, onSelect }: ServerPathPickerProps) {
  const [currentPath, setCurrentPath] = React.useState(initialPath || "/");
  const [parentPath, setParentPath] = React.useState<string | null>(null);
  const [directories, setDirectories] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const browse = React.useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const directory = await loadServerDirectory(path);
      setCurrentPath(directory.currentPath);
      setParentPath(directory.parentPath);
      setDirectories(directory.directories);
    } catch (browseError) {
      setError(browseError instanceof Error ? browseError.message : String(browseError));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void browse(initialPath || "/"); }, [browse, initialPath]);

  return (
    <section className="v2-path-picker" aria-labelledby="v2-path-picker-title">
      <header>
        <div>
          <span className="v2-eyebrow">Server filesystem</span>
          <h3 id="v2-path-picker-title">Choose {label.toLowerCase()}</h3>
        </div>
        <button type="button" className="v2-icon-button" aria-label="Close directory browser" onClick={onCancel}><X /></button>
      </header>
      <code title={currentPath}>{currentPath}</code>
      {error && <div className="v2-path-error" role="alert">{error}</div>}
      <div className="v2-path-list" aria-busy={loading}>
        {loading ? (
          <div className="v2-path-loading" role="status"><LoaderCircle className="spin" /> Loading directories…</div>
        ) : (
          <>
            {parentPath && <button type="button" onClick={() => void browse(parentPath)}><ArrowUp /><span><strong>Parent directory</strong><small>{parentPath}</small></span></button>}
            {directories.map((directory) => (
              <button type="button" key={directory} onClick={() => void browse(joinPath(currentPath, directory))}>
                <Folder /><span><strong>{directory}</strong><small>Open folder</small></span>
              </button>
            ))}
            {directories.length === 0 && <p>No subdirectories are visible here.</p>}
          </>
        )}
      </div>
      <footer>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={loading || Boolean(error)} onClick={() => onSelect(currentPath)}><FolderOpen /> Use this directory</button>
      </footer>
    </section>
  );
}
