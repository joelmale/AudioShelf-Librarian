import React, { useState, useEffect } from 'react';
import type { SystemSettings } from '@audioshelf/shared';
import { DirectoryBrowserModal } from './DirectoryBrowserModal.js';

export function SettingsPage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [browserField, setBrowserField] = useState<'libraryDir' | 'inboxDir' | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/system/settings')
      .then(r => r.json())
      .then(res => {
        if (res.success) {
          setSettings(res.data);
        } else {
          setError(res.error || "Failed to load settings");
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    
    setSaving(true);
    setError(null);
    setSuccessMsg(null);
    
    try {
      const res = await fetch('/api/system/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      const data = await res.json();
      if (data.success) {
        setSettings(data.data);
        setSuccessMsg("Settings saved successfully!");
      } else {
        setError(data.error || "Failed to save settings");
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div>Loading settings...</div>;

  return (
    <div className="card">
      <h1>System Settings</h1>
      
      {error && <div className="error" style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
      {successMsg && <div className="success" style={{ color: 'green', marginBottom: '1rem' }}>{successMsg}</div>}
      
      <form onSubmit={handleSave}>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
            Library Directory
          </label>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.9rem', color: '#666' }}>
            The base directory where your organized Audiobooks are stored.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input 
              type="text" 
              style={{ flex: 1, padding: '0.5rem' }}
              value={settings?.libraryDir || ""}
              onChange={e => setSettings(s => s ? { ...s, libraryDir: e.target.value } : null)}
            />
            <button 
              type="button" 
              onClick={() => setBrowserField('libraryDir')}
              style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}
            >
              Browse...
            </button>
          </div>
        </div>
        
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
            Inbox Directory
          </label>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.9rem', color: '#666' }}>
            The directory where new, unorganized books are dropped for scanning.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input 
              type="text" 
              style={{ flex: 1, padding: '0.5rem' }}
              value={settings?.inboxDir || ""}
              onChange={e => setSettings(s => s ? { ...s, inboxDir: e.target.value } : null)}
            />
            <button 
              type="button" 
              onClick={() => setBrowserField('inboxDir')}
              style={{ padding: '0.5rem 1rem', cursor: 'pointer' }}
            >
              Browse...
            </button>
          </div>
        </div>
        
        <button 
          type="submit" 
          disabled={saving}
          style={{ padding: '0.5rem 1rem', background: '#0070f3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </form>
      
      <DirectoryBrowserModal 
        isOpen={browserField !== null}
        initialPath={browserField === 'libraryDir' ? settings?.libraryDir : settings?.inboxDir}
        onSelect={(path) => {
          if (browserField) {
            setSettings(s => s ? { ...s, [browserField]: path } : null);
          }
          setBrowserField(null);
        }}
        onCancel={() => setBrowserField(null)}
      />
    </div>
  );
}
