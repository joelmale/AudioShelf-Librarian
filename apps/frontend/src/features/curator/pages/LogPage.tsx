import { Fragment, useState } from 'react';

import { useLog } from '../api';

export function LogPage() {
  const log = useLog();
  const [open, setOpen] = useState<number | null>(null);

  return (
    <div>
      <h1>Operation log</h1>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Operation</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(log.data ?? []).map((l) => (
              <Fragment key={l.id}>
                <tr>
                  <td>{l.operation}</td>
                  <td>
                    <span className={`badge ${l.status}`}>{l.status}</span>
                  </td>
                  <td className="muted">{new Date(l.startedAt).toLocaleString()}</td>
                  <td className="muted">{l.finishedAt ? new Date(l.finishedAt).toLocaleTimeString() : '—'}</td>
                  <td>
                    {l.detail != null && (
                      <button className="btn secondary" style={{ padding: '2px 8px' }} onClick={() => setOpen(open === l.id ? null : l.id)}>
                        {open === l.id ? 'Hide' : 'Detail'}
                      </button>
                    )}
                  </td>
                </tr>
                {open === l.id && (
                  <tr>
                    <td colSpan={5}>
                      <pre className="log-stream" style={{ margin: 0 }}>
                        {JSON.stringify(l.detail, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {(log.data ?? []).length === 0 && <span className="muted">No operations logged yet.</span>}
      </div>
    </div>
  );
}
