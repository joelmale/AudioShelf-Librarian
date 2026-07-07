import React, { useState, useEffect } from 'react';
import type { SystemSettings } from '@audioshelf/shared';
import { DirectoryBrowserModal } from './DirectoryBrowserModal.js';
import { api, useHealth, useTagStats } from '../curator/api.js';
import { useToast } from '../curator/toast.js';

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function SettingsPage() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [browserField, setBrowserField] = useState<'libraryDir' | 'inboxDir' | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const health = useHealth();
  const stats = useTagStats();
  const toast = useToast();
  
  const [level, setLevel] = useState('info');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

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

  const testAbs = async () => {
    setTesting(true);
    const start = performance.now();
    try {
      const h = await api.health();
      const ms = Math.round(performance.now() - start);
      setTestResult(h.absConnected ? `Connected in ${ms}ms` : `Not connected (${ms}ms)`);
      // Also invalidate health cache so the green dot updates
      health.refetch();
    } catch {
      setTestResult('Health check failed');
    } finally {
      setTesting(false);
    }
  };

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
        toast('Settings updated', 'success');
      } else {
        setError(data.error || "Failed to save settings");
        toast('Failed to save settings', 'error');
      }
    } catch (e: any) {
      setError(e.message);
      toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div>Loading settings...</div>;

  return (
    <div className="card">
      <h1>Settings</h1>

      <h2>ABS connection</h2>
      <div className="card">
        <div className="row">
          <span className={`dot ${health.data?.absConnected ? 'ok' : 'bad'}`} />
          {health.data?.absConnected ? 'Connected' : 'Not connected'}
          <span className="spacer" />
          <button className="btn secondary" onClick={testAbs} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
        {testResult && <p className="muted" style={{marginTop: '0.5rem'}}>{testResult}</p>}
      </div>

      <h2>Logging verbosity</h2>
      <div className="card">
        <p className="muted">
          Controls how much detail the troubleshooting action log retains. Raise to <code>debug</code> before
          reproducing an issue.
        </p>
        <div className="row">
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={async () => {
              await api.setLogLevel(level);
              toast(`Action-log verbosity set to ${level}`, 'success');
            }}
          >
            Apply
          </button>
        </div>
      </div>

      <h2>Runtime</h2>
      <div className="card">
        <table className="table">
          <tbody>
            <tr>
              <td>Version</td>
              <td>{health.data?.version ?? '—'}</td>
            </tr>
            <tr>
              <td>Database writable</td>
              <td>{health.data?.dbWritable ? 'yes' : 'no'}</td>
            </tr>
            <tr>
              <td>Books / tagged</td>
              <td>
                {stats.data?.totalBooks ?? '—'} / {stats.data?.taggedBooks ?? '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr style={{margin: '2rem 0', borderColor: '#eee'}} />
      
      <h2>Application Configuration</h2>
      <p className="muted">Update core integration URLs and API Keys. Changes take effect immediately.</p>
      
      {error && <div className="error" style={{ color: 'red', marginBottom: '1rem' }}>{error}</div>}
      {successMsg && <div className="success" style={{ color: 'green', marginBottom: '1rem' }}>{successMsg}</div>}
      
      <form onSubmit={handleSave}>
        
        <h3>Proxy Configuration (Gluetun)</h3>
        <p className="muted" style={{ margin: '0 0 0.5rem', fontSize: '0.9rem' }}>Used to bypass region blocks for AudiobookBay.</p>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Proxy URL</label>
          <input 
            type="text" 
            placeholder="http://gluetun:8888"
            style={{ width: '100%', padding: '0.5rem' }}
            value={settings?.proxyUrl || ""}
            onChange={e => setSettings(s => s ? { ...s, proxyUrl: e.target.value } : null)}
          />
        </div>

        <h3>Audiobookshelf Integration</h3>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>ABS URL</label>
          <input 
            type="text" 
            placeholder="http://audiobookshelf:80"
            style={{ width: '100%', padding: '0.5rem' }}
            value={settings?.absUrl || ""}
            onChange={e => setSettings(s => s ? { ...s, absUrl: e.target.value } : null)}
          />
        </div>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>ABS Token</label>
          <input 
            type="password" 
            style={{ width: '100%', padding: '0.5rem' }}
            value={settings?.absToken || ""}
            onChange={e => setSettings(s => s ? { ...s, absToken: e.target.value } : null)}
          />
        </div>

        <h3>Anthropic AI Integration</h3>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Provider Priority</label>
          <select 
            style={{ width: '100%', padding: '0.5rem' }}
            value={settings?.llmPriority || "cloud-first"}
            onChange={e => setSettings(s => s ? { ...s, llmPriority: e.target.value as 'local-first' | 'cloud-first' } : null)}
          >
            <option value="cloud-first">Cloud First (Anthropic → Ollama)</option>
            <option value="local-first">Local First (Ollama → Anthropic)</option>
          </select>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Anthropic API Key</label>
          <input 
            type="password" 
            style={{ width: '100%', padding: '0.5rem' }}
            value={settings?.anthropicApiKey || ""}
            onChange={e => setSettings(s => s ? { ...s, anthropicApiKey: e.target.value } : null)}
          />
        </div>

        <h3>Ollama Local AI Integration</h3>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Ollama URL</label>
            <input 
              type="text" 
              placeholder="http://ollama:11434"
              style={{ width: '100%', padding: '0.5rem' }}
              value={settings?.ollamaUrl || ""}
              onChange={e => setSettings(s => s ? { ...s, ollamaUrl: e.target.value } : null)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Model Name</label>
            <input 
              type="text" 
              placeholder="mistral-nemo:latest"
              style={{ width: '100%', padding: '0.5rem' }}
              value={settings?.ollamaModel || ""}
              onChange={e => setSettings(s => s ? { ...s, ollamaModel: e.target.value } : null)}
            />
          </div>
        </div>

        <h3>qBittorrent Integration</h3>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>qBittorrent URL</label>
          <input 
            type="text" 
            placeholder="http://qbittorrent:8080"
            style={{ width: '100%', padding: '0.5rem' }}
            value={settings?.qbitUrl || ""}
            onChange={e => setSettings(s => s ? { ...s, qbitUrl: e.target.value } : null)}
          />
        </div>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Username</label>
            <input 
              type="text" 
              style={{ width: '100%', padding: '0.5rem' }}
              value={settings?.qbitUser || ""}
              onChange={e => setSettings(s => s ? { ...s, qbitUser: e.target.value } : null)}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Password</label>
            <input 
              type="password" 
              style={{ width: '100%', padding: '0.5rem' }}
              value={settings?.qbitPass || ""}
              onChange={e => setSettings(s => s ? { ...s, qbitPass: e.target.value } : null)}
            />
          </div>
        </div>

        <h3>Directory Configuration</h3>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Library Directory</label>
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
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>Inbox Directory</label>
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
          style={{ padding: '0.5rem 1rem', background: '#0070f3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', marginTop: '1rem' }}
        >
          {saving ? "Saving..." : "Save Configuration"}
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
