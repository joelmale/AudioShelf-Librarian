import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowUp } from 'lucide-react';

import { api, formatDuration, useCollection, useInvalidate, useMutation, type Book } from '../api';
import { useToast } from '../toast';
import { TagCloud } from '../components/TagPill';

export function CollectionDetail() {
  const { id = '' } = useParams();
  const cid = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();
  const collection = useCollection(cid);

  const [order, setOrder] = useState<Book[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [policy, setPolicy] = useState('skip');

  useEffect(() => {
    if (collection.data) {
      setOrder(collection.data.books ?? []);
      setName(collection.data.name);
      setDesc(collection.data.description ?? '');
    }
  }, [collection.data]);

  const refresh = () => invalidate(['collection', 'collections']);

  const setStatus = useMutation({
    mutationFn: (action: 'approve' | 'reject') =>
      action === 'approve' ? api.approve(cid) : api.reject(cid),
    onSuccess: (_d, action) => {
      refresh();
      toast(`Collection ${action === 'approve' ? 'approved' : 'rejected'}`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const push = useMutation({
    mutationFn: () => api.push(cid, policy),
    onSuccess: (r) => {
      refresh();
      toast(`Pushed to ABS (${r.action}): ${r.finalName}`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const move = (index: number, dir: -1 | 1) => {
    const next = [...order];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j]!, next[index]!];
    setOrder(next);
    api.reorder(cid, next.map((b) => b.id)).then(() => toast('Order saved'));
  };

  if (collection.isLoading) return <p className="muted">Loading…</p>;
  if (!collection.data) return <p className="muted">Collection not found.</p>;
  const c = collection.data;

  return (
    <div>
      <Link to="/curator/collections" className="muted">
        ← Collections
      </Link>
      <div className="row" style={{ marginTop: 8 }}>
        <h1 style={{ margin: 0 }}>{c.name}</h1>
        <span className={`badge ${c.status}`}>{c.status}</span>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        {editing ? (
          <div>
            <label>Name</label>
            <input style={{ width: '100%', marginBottom: 8 }} value={name} onChange={(e) => setName(e.target.value)} />
            <label>Description</label>
            <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
            <div className="btn-row" style={{ marginTop: 8 }}>
              <button
                className="btn"
                onClick={async () => {
                  await api.patchCollection(cid, { name, description: desc });
                  setEditing(false);
                  refresh();
                  toast('Saved');
                }}
              >
                Save
              </button>
              <button className="btn secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <div>
              <div className="muted">{c.description || 'No description'}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {order.length} books · theme: {c.theme}
              </div>
            </div>
            <span className="spacer" />
            <button className="btn secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 14 }}>
          {c.status === 'proposed' && (
            <button className="btn" onClick={() => setStatus.mutate('approve')}>
              Approve
            </button>
          )}
          {c.status !== 'rejected' && c.status !== 'pushed' && (
            <button className="btn danger" onClick={() => setStatus.mutate('reject')}>
              Reject
            </button>
          )}
          <span className="spacer" />
          <label className="muted">conflict</label>
          <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
            <option value="skip">skip</option>
            <option value="overwrite">overwrite</option>
            <option value="rename">rename</option>
          </select>
          <button
            className="btn"
            disabled={(c.status !== 'approved' && c.status !== 'pushed') || push.isPending || order.length === 0}
            onClick={() => push.mutate()}
          >
            {c.status === 'pushed' ? 'Re-push to ABS' : 'Push to ABS'}
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              await api.deleteCollection(cid);
              toast('Deleted');
              navigate('/collections');
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <h2>Books</h2>
      <div className="card">
        <table className="table">
          <tbody>
            {order.map((b, i) => (
              <tr key={b.id}>
                <td style={{ width: 60 }}>
                  <button className="btn secondary" style={{ padding: '2px 6px' }} onClick={() => move(i, -1)}>
                    <ArrowUp size={14} />
                  </button>{' '}
                  <button className="btn secondary" style={{ padding: '2px 6px' }} onClick={() => move(i, 1)}>
                    <ArrowDown size={14} />
                  </button>
                </td>
                <td>
                  <Link to={`/books/${b.id}`}>{b.title}</Link>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {b.author ?? 'Unknown'} · {formatDuration(b.durationSeconds)}
                  </div>
                </td>
                <td>
                  <TagCloud tags={b.tags ?? []} max={4} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {order.length === 0 && <span className="muted">No books in this collection.</span>}
      </div>
    </div>
  );
}
