import { Link } from 'react-router-dom';

import { api, useCollections, useInvalidate, useLog, useMutation, useTagStats } from '../api';
import { useToast } from '../toast';

function Stat({ num, label }: { num: number | string; label: string }) {
  return (
    <div className="card stat">
      <div className="num">{num}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function Dashboard() {
  const stats = useTagStats();
  const collections = useCollections();
  const log = useLog();
  const invalidate = useInvalidate();
  const toast = useToast();

  const sync = useMutation({
    mutationFn: api.sync,
    onSuccess: () => {
      toast('Library synced', 'success');
      invalidate(['tagStats', 'log', 'books']);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const byStatus = (s: string) => collections.data?.filter((c) => c.status === s).length ?? 0;

  return (
    <div>
      <h1>Dashboard</h1>
      <div className="grid stat-grid">
        <Stat num={stats.data?.totalBooks ?? '—'} label="Books" />
        <Stat num={stats.data?.taggedBooks ?? '—'} label="Tagged" />
        <Stat num={stats.data?.untaggedBooks ?? '—'} label="Untagged" />
        <Stat num={stats.data?.vocabularySize ?? '—'} label="Unique tags" />
      </div>

      <h2>Quick actions</h2>
      <div className="card">
        <div className="btn-row">
          <button className="btn" onClick={() => sync.mutate()} disabled={sync.isPending}>
            {sync.isPending ? 'Syncing…' : 'Sync library'}
          </button>
          <Link className="btn secondary" to="tag">
            Tag untagged
          </Link>
          <Link className="btn secondary" to="collections">
            Generate collections
          </Link>
        </div>
      </div>

      <h2>Collections</h2>
      <div className="grid stat-grid">
        <Stat num={byStatus('proposed')} label="Proposed" />
        <Stat num={byStatus('approved')} label="Approved" />
        <Stat num={byStatus('pushed')} label="Pushed" />
        <Stat num={byStatus('rejected')} label="Rejected" />
      </div>

      <h2>Recent activity</h2>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Operation</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {(log.data ?? []).slice(0, 8).map((l) => (
              <tr key={l.id}>
                <td>{l.operation}</td>
                <td>
                  <span className={`badge ${l.status}`}>{l.status}</span>
                </td>
                <td className="muted">{new Date(l.startedAt).toLocaleString()}</td>
              </tr>
            ))}
            {(log.data ?? []).length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No activity yet — sync your library to begin.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
