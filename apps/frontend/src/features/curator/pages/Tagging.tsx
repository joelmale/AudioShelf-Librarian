import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, useInvalidate, useMutation, useOperation, useOperations, useTagStats } from '../api';
import { useToast } from '../toast';
import { TagAnalytics } from '../components/TagAnalytics';

// Rough Haiku pricing for the running estimate ($/1M tokens).
const IN_PER_BOOK = 1800;
const OUT_PER_BOOK = 300;
const IN_COST = 1.0;
const OUT_COST = 5.0;

function estimateCost(books: number): string {
  const cost = (books * IN_PER_BOOK * IN_COST + books * OUT_PER_BOOK * OUT_COST) / 1_000_000;
  return `$${cost.toFixed(2)}`;
}

export function Tagging() {
  const stats = useTagStats();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [opId, setOpId] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [sample, setSample] = useState(false);
  const op = useOperation(opId);
  const operationsQuery = useOperations();
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!opId && operationsQuery.data) {
      const activeTagOp = operationsQuery.data.find(o => o.type === 'tag' && !['completed', 'cancelled', 'error'].includes(o.status));
      if (activeTagOp) {
        setOpId(activeTagOp.id);
      }
    }
  }, [operationsQuery.data, opId]);

  const logs = useQuery({
    queryKey: ['actionLogs', opId],
    queryFn: () => api.actionLogs({ operationId: opId as string, limit: '200' }),
    enabled: Boolean(opId),
    refetchInterval: op.data && ['completed', 'cancelled', 'error'].includes(op.data.status) ? false : 1000,
  });

  useEffect(() => {
    logEnd.current?.scrollIntoView();
  }, [logs.data]);

  useEffect(() => {
    if (op.data && ['completed', 'cancelled', 'error'].includes(op.data.status)) {
      invalidate(['tagStats', 'books', 'vocabulary']);
    }
  }, [op.data?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useMutation({
    mutationFn: () => api.tagRun({ dryRun, sample }),
    onSuccess: (r) => {
      setOpId(r.operationId);
      toast(dryRun ? 'Dry run started' : 'Tagging started', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const untagged = stats.data?.untaggedBooks ?? 0;
  const active = op.data && !['completed', 'cancelled', 'error'].includes(op.data.status);
  const progress = op.data?.progress;
  const pct = progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div>
      <h1>Tagging</h1>
      <div className="grid stat-grid">
        <div className="card stat">
          <div className="num">{stats.data?.taggedBooks ?? '—'}</div>
          <div className="label">Tagged</div>
        </div>
        <div className="card stat">
          <div className="num">{untagged}</div>
          <div className="label">Untagged</div>
        </div>
        <div className="card stat">
          <div className="num">{estimateCost(untagged)}</div>
          <div className="label">Est. cost (full)</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <label className="checkbox">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={active} />
            Dry run (no API calls)
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} disabled={active} />
            Sample only (max 20 or 5%)
          </label>
          <span className="spacer" />
          <button className="btn" onClick={() => run.mutate()} disabled={Boolean(active) || untagged === 0}>
            Tag all untagged
          </button>
        </div>

        {op.data && (
          <div style={{ marginTop: 16 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className={`badge ${op.data.status}`}>{op.data.status}</span>
              <span className="muted">
                {progress?.current ?? 0} / {progress?.total ?? 0} {progress?.message ? `· ${progress.message}` : ''}
              </span>
              <span className="spacer" />
              {active && op.data.status === 'running' && (
                <button className="btn secondary" onClick={() => api.pauseOp(op.data!.id)}>
                  Pause
                </button>
              )}
              {active && op.data.status === 'paused' && (
                <button className="btn secondary" onClick={() => api.resumeOp(op.data!.id)}>
                  Resume
                </button>
              )}
              {active && (
                <button className="btn danger" onClick={() => api.cancelOp(op.data!.id)}>
                  Cancel
                </button>
              )}
            </div>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </div>

      {opId && (
        <>
          <h2>Live log</h2>
          <div className="log-stream">
            {(logs.data ?? []).map((l, i) => (
              <div key={i} className={`log-line ${l.level}`}>
                [{new Date(l.ts).toLocaleTimeString()}] {l.event}: {l.message}
              </div>
            ))}
            <div ref={logEnd} />
          </div>
        </>
      )}

      <TagAnalytics />
    </div>
  );
}
