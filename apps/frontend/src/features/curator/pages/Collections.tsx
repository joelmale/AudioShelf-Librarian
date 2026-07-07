import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, useCollections, useInvalidate, useMutation, useOperation, useTemplates } from '../api';
import { useToast } from '../toast';

const TABS = ['proposed', 'approved', 'pushed', 'rejected'] as const;

function GenerateModal({ onClose }: { onClose: () => void }) {
  const templates = useTemplates();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [opId, setOpId] = useState<string | null>(null);
  const op = useOperation(opId);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const generate = useMutation({
    mutationFn: () =>
      api.generate({
        templateIds: [...selected].filter((id) => id !== 'custom'),
        customPrompt: selected.has('custom') ? prompt : undefined,
      }),
    onSuccess: (r) => {
      invalidate(['collections']);
      if (r.collections.length > 0) toast(`Generated ${r.collections.length} collection(s)`, 'success');
      if (r.operationId) setOpId(r.operationId);
      else onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const customDone = op.data && ['completed', 'cancelled', 'error'].includes(op.data.status);
  useEffect(() => {
    if (op.data?.status === 'completed') invalidate(['collections']);
  }, [op.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Generate collections</h2>
        <div className="tmpl-grid">
          {(templates.data ?? []).map((t) => (
            <div
              key={t.id}
              className={`tmpl ${selected.has(t.id) ? 'sel' : ''}`}
              onClick={() => toggle(t.id)}
            >
              <strong>{t.name}</strong>
              {t.usesClaude && <span className="pill theme" style={{ marginLeft: 6 }}>AI</span>}
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {t.description}
              </div>
            </div>
          ))}
        </div>

        {selected.has('custom') && (
          <div style={{ marginTop: 14 }}>
            <label>Describe your theme</label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. optimistic space exploration under 10 hours"
            />
          </div>
        )}

        {op.data && (
          <p className="muted" style={{ marginTop: 10 }}>
            Processing: <span className={`badge ${op.data.status}`}>{op.data.status}</span>
            {op.data.error && ` — ${op.data.error.message}`}
          </p>
        )}

        <div className="btn-row" style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 18 }}>
          <button
            className="btn"
            disabled={selected.size === 0 || generate.isPending || (Boolean(opId) && !customDone)}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? 'Generating…' : 'Generate Selected'}
          </button>
          
          <div style={{ flex: 1 }} />
          
          <button
            className="glass-btn"
            style={{ 
              background: 'linear-gradient(135deg, rgba(109, 182, 184, 0.2), rgba(138, 180, 248, 0.2))',
              border: '1px solid var(--accent)',
              color: 'var(--text)'
            }}
            disabled={generate.isPending || discover.isPending || (Boolean(opId) && !customDone)}
            onClick={() => discover.mutate()}
          >
            {discover.isPending ? 'Discovering...' : '✨ Auto-Discover Patterns (Local AI)'}
          </button>
          
          <button className="btn secondary" onClick={onClose} style={{ marginLeft: '12px' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export function Collections() {
  const [tab, setTab] = useState<string>('proposed');
  const [modal, setModal] = useState(false);
  const collections = useCollections(tab);
  const invalidate = useInvalidate();
  const toast = useToast();


  const [opId, setOpId] = useState<string | null>(null);
  const op = useOperation(opId);

  const discover = useMutation({
    mutationFn: () => api.discover(),
    onSuccess: (r) => {
      invalidate(['collections']);
      setOpId(r.operationId);
      toast('AI Auto-Discovery started...', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const customDone = op.data && ['completed', 'cancelled', 'error'].includes(op.data.status);
  useEffect(() => {
    if (op.data?.status === 'completed') invalidate(['collections']);
  }, [op.data?.status]);

  const pushAll = useMutation({
    mutationFn: () => api.pushAll('skip'),
    onSuccess: (r) => {
      invalidate(['collections']);
      toast(`Pushed ${r.results.length}, ${r.errors.length} error(s)`, r.errors.length ? 'error' : 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <div>
      <div className="row">
        <h1 style={{ margin: 0 }}>Collections</h1>
        <span className="spacer" />
        {tab === 'approved' && (
          <button className="btn secondary" onClick={() => pushAll.mutate()} disabled={pushAll.isPending}>
            Push all approved
          </button>
        )}

        <button
          className="glass-btn"
          style={{ 
            background: 'linear-gradient(135deg, rgba(109, 182, 184, 0.2), rgba(138, 180, 248, 0.2))',
            border: '1px solid var(--accent)',
            color: 'var(--text)',
            marginRight: '12px'
          }}
          disabled={discover.isPending || (Boolean(opId) && !customDone)}
          onClick={() => discover.mutate()}
        >
          {discover.isPending ? 'Discovering...' : '✨ Auto-Discover Patterns (Local AI)'}
        </button>
        <button className="btn" onClick={() => setModal(true)}>

          Generate new
        </button>
      </div>


      {op.data && op.data.status !== 'completed' && (
        <div className="muted" style={{ marginBottom: 16 }}>
          AI Auto-Discovery Processing: <span className={`badge ${op.data.status}`}>{op.data.status}</span>
          {op.data.error && ` — ${op.data.error.message}`}
        </div>
      )}

      <div className="row" style={{ margin: '16px 0' }}>

        {TABS.map((t) => (
          <button key={t} className={`btn ${tab === t ? '' : 'secondary'}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="book-grid">
        {(collections.data ?? []).map((c) => (
          <Link key={c.id} to={`/curator/collections/${c.id}`} className="book-card">
            <div className="row">
              <span className={`badge ${c.status}`}>{c.status}</span>
            </div>
            <div className="title" style={{ marginTop: 8 }}>
              {c.name}
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {c.description}
            </div>
          </Link>
        ))}
      </div>
      {(collections.data ?? []).length === 0 && <p className="muted">No {tab} collections.</p>}

      {modal && <GenerateModal onClose={() => setModal(false)} />}
    </div>
  );
}
