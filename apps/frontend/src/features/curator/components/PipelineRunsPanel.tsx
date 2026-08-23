import { useEffect, useState, type ReactNode } from 'react';

import {
  api,
  useInvalidate,
  useMutation,
  useOperation,
  useOperations,
  type EnrichmentQualityReport,
  type EnrichmentRunResult,
} from '../api';
import { useToast } from '../toast';

const TERMINAL_STATUSES = ['completed', 'cancelled', 'error'];

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A determinate progress bar. Reuses the global `.progress` tokens (same
 *  pattern as `features/encoder/atoms/ProgressBar.tsx`). */
function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * QC summary from a finished enrichment run — the artifact a human reads to
 * decide whether to trust a sample enough to commit to a full-library run.
 */
function QualityReportView({ report }: { report: EnrichmentQualityReport }) {
  const providers = Object.entries(report.providers);
  const { entityCoverage } = report;

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ margin: '0 0 8px 0' }}>Quality report</h4>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px 0' }}>
        Sampled {report.sampled} of {report.candidatesTotal} candidate{report.candidatesTotal === 1 ? '' : 's'}.
      </p>

      <table className="table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Resolved</th>
            <th>Not found</th>
            <th>Errors</th>
            <th>Hit rate</th>
          </tr>
        </thead>
        <tbody>
          {providers.map(([name, stats]) => (
            <tr key={name}>
              <td>{name}</td>
              <td>{stats.ok}</td>
              <td>{stats.notFound}</td>
              <td>{stats.errors}</td>
              <td>{Math.round(stats.hitRate * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted" style={{ fontSize: 13, margin: '12px 0' }}>
        Entity coverage: {entityCoverage.withEntities} book{entityCoverage.withEntities === 1 ? '' : 's'} with
        entities, {entityCoverage.withoutEntities} without ({entityCoverage.avgEntitiesPerBook.toFixed(1)} avg/book).
      </p>

      {report.examples.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Book</th>
              <th>Providers</th>
              <th>Entities</th>
              <th>Subjects</th>
            </tr>
          </thead>
          <tbody>
            {report.examples.map((ex) => (
              <tr key={ex.bookId}>
                <td>{ex.title}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {Object.entries(ex.providers)
                    .map(([provider, status]) => `${provider}: ${status}`)
                    .join(', ') || '—'}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {ex.entities.map((e) => e.entity).join(', ') || '—'}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {ex.subjects.join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface RunSectionProps {
  opType: 'enrich' | 'embed';
  title: string;
  helperText: string;
  runLabel: string;
  invalidateKeys: string[];
  onRun: (body: { dryRun: boolean; sample: boolean }) => Promise<{ operationId: string; status: string }>;
  operationsQuery: ReturnType<typeof useOperations>;
  /** Only enrichment renders anything here — its result carries a `qualityReport`. */
  renderSummary?: (summary: unknown) => ReactNode;
}

/**
 * One run-control block (checkboxes + run button + live progress +
 * pause/resume/cancel), shared by the enrichment and embeddings sections.
 * Mirrors `pages/Tagging.tsx`'s run-control block.
 */
function RunSection({
  opType,
  title,
  helperText,
  runLabel,
  invalidateKeys,
  onRun,
  operationsQuery,
  renderSummary,
}: RunSectionProps) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [dryRun, setDryRun] = useState(false);
  const [sample, setSample] = useState(false);
  // Tracked explicitly (rather than re-derived from the operations list every
  // render, as Tagging.tsx does) so a finished run's quality report stays on
  // screen instead of disappearing once the op drops out of the "active" list.
  const [opId, setOpId] = useState<string | null>(null);

  // Pick up an already-running operation of this type on mount/reload.
  useEffect(() => {
    if (opId) return;
    const active = operationsQuery.data?.find((o) => o.type === opType && !isTerminal(o.status));
    if (active) setOpId(active.id);
  }, [operationsQuery.data, opId, opType]);

  const op = useOperation(opId);

  useEffect(() => {
    if (op.data && isTerminal(op.data.status)) {
      invalidate(invalidateKeys);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op.data?.status]);

  const run = useMutation({
    mutationFn: () => onRun({ dryRun, sample }),
    onSuccess: (result) => {
      setOpId(result.operationId);
      invalidate(['operations']);
      toast(dryRun ? 'Dry run started' : `${runLabel} started`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const active = op.data ? !isTerminal(op.data.status) : false;
  const progress = op.data?.progress;

  return (
    <div>
      <h3 style={{ margin: '0 0 4px 0' }}>{title}</h3>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px 0' }}>{helperText}</p>

      <div className="row">
        <label className="checkbox">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={active} />
          Dry run (no calls)
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} disabled={active} />
          Sample only (max 20 or 5%)
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => run.mutate()} disabled={active || run.isPending}>
          {runLabel}
        </button>
      </div>

      {op.data && (
        <div className="card" style={{ marginTop: 12, background: 'var(--bg-2)' }}>
          <div className="row">
            <span className={`badge ${op.data.status}`}>{op.data.status.toUpperCase()}</span>
            <span className="muted" style={{ fontSize: 13 }}>
              {progress?.current ?? 0} of {progress?.total ?? 0}
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

          <div style={{ marginTop: 8 }}>
            <ProgressBar current={progress?.current ?? 0} total={progress?.total ?? 0} />
          </div>

          {progress?.message && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {progress.message}
            </div>
          )}

          {!active && renderSummary && op.data.summary != null ? renderSummary(op.data.summary) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Run controls for the two Phase 3.5 pipeline operations (librarian engine
 * plan) that otherwise only exist as API routes: metadata enrichment
 * (`POST /enrichment/run`) and embeddings (`POST /embeddings/run`). Gives them
 * the same dry-run / sample / progress / pause-resume-cancel treatment as
 * tagging, plus — for enrichment — the quality report a human needs to decide
 * whether a sample is good enough to trust for a full run.
 */
export function PipelineRunsPanel() {
  const operationsQuery = useOperations();

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ margin: '0 0 16px 0' }}>Pipeline runs</h2>

      <RunSection
        opType="enrich"
        title="Metadata enrichment"
        helperText="Fetches missing metadata from Open Library and Audnexus, and rebuilds character/place/time entities. Sample is the recommended first step — it's a real run over a handful of books, cheap enough to check provider hit rates and entity coverage before committing to the full library."
        runLabel="Run enrichment"
        invalidateKeys={['books', 'operations']}
        onRun={(body) => api.enrichmentRun(body)}
        operationsQuery={operationsQuery}
        renderSummary={(summary) => {
          const result = summary as EnrichmentRunResult;
          return result.qualityReport ? <QualityReportView report={result.qualityReport} /> : null;
        }}
      />

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

      <RunSection
        opType="embed"
        title="Embeddings"
        helperText="Re-embeds each active book's composed card via the configured Ollama model. Driven by card_hash staleness, so an unchanged library costs zero embed calls on re-run. Sample is the recommended first step."
        runLabel="Run embeddings"
        invalidateKeys={['operations']}
        onRun={(body) => api.embeddingsRun(body)}
        operationsQuery={operationsQuery}
      />
    </div>
  );
}
