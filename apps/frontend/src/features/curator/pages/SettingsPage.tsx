import { useState } from 'react';

import { api, useHealth, useTagStats } from '../api';
import { useToast } from '../toast';

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function SettingsPage() {
  const health = useHealth();
  const stats = useTagStats();
  const toast = useToast();
  const [level, setLevel] = useState('info');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const testAbs = async () => {
    setTesting(true);
    const start = performance.now();
    try {
      const h = await api.health();
      const ms = Math.round(performance.now() - start);
      setTestResult(h.absConnected ? `Connected in ${ms}ms` : `Not connected (${ms}ms)`);
    } catch {
      setTestResult('Health check failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
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
        {testResult && <p className="muted">{testResult}</p>}
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
    </div>
  );
}
