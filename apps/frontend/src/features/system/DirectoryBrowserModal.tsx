import React, { useState, useEffect } from 'react';

interface Props {
  isOpen: boolean;
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

export function DirectoryBrowserModal({ isOpen, initialPath, onSelect, onCancel }: Props) {
  const [currentPath, setCurrentPath] = useState<string>(initialPath || '/');
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadDirectory(initialPath || '/');
    }
  }, [isOpen, initialPath]);

  const loadDirectory = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/system/fs?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.success) {
        setCurrentPath(data.currentPath);
        setParentPath(data.parentPath);
        setDirectories(data.directories);
      } else {
        setError(data.error || "Failed to load directory");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000
    }}>
      <div className="card" style={{ width: '500px', maxWidth: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ marginTop: 0 }}>Browse Server Directory</h2>
        <div style={{ padding: '0.5rem', backgroundColor: '#f0f0f0', borderRadius: '4px', marginBottom: '1rem', fontFamily: 'monospace', overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {currentPath}
        </div>
        
        {error && <div className="error" style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
        
        <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #ccc', borderRadius: '4px', padding: '0.5rem' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '1rem' }}>Loading...</div>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {parentPath && (
                <li 
                  onClick={() => loadDirectory(parentPath)}
                  style={{ padding: '0.5rem', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                  onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f5f5f5'}
                  onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <span style={{ marginRight: '0.5rem' }}>📁</span> ..
                </li>
              )}
              {directories.length === 0 && !parentPath && (
                <li style={{ padding: '0.5rem', color: '#666', fontStyle: 'italic' }}>No subdirectories</li>
              )}
              {directories.map(dir => (
                <li 
                  key={dir} 
                  onClick={() => loadDirectory(currentPath === '/' ? `/${dir}` : `${currentPath}/${dir}`)}
                  style={{ padding: '0.5rem', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                  onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f5f5f5'}
                  onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <span style={{ marginRight: '0.5rem' }}>📁</span> {dir}
                </li>
              ))}
            </ul>
          )}
        </div>
        
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem' }}>
          <button onClick={onCancel} style={{ padding: '0.5rem 1rem', background: '#ccc', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
            Cancel
          </button>
          <button 
            onClick={() => onSelect(currentPath)} 
            style={{ padding: '0.5rem 1rem', background: '#0070f3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            Select Current Directory
          </button>
        </div>
      </div>
    </div>
  );
}
