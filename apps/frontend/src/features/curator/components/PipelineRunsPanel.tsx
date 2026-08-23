import { useEffect, useState, type ReactNode } from 'react';

import {
  api,
  useInvalidate,
  useMutation,
  useOperation,
  useOperations,
  type EnrichmentQualityReport,
  type EnrichmentRunResult,
  type TitleParseReviewEntry,
  type TitleParseRunResult,
} from '../api';
import { useToast } from '../toast';

const TERMINAL_STATUSES = ['completed', 'cancelled', 'error'];

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * A dry run never calls `setProgress` — it returns its plan synchronously, so
 * `progress.current`/`progress.total` are stuck at their initial 0/0. Reading
 * the plan size straight off the finished operation's summary (`plan.length`,
 * falling back to `skipped` — the dry-run branch sets both to the same count)
 * lets the panel show "958 books would be enriched" instead of a meaningless
 * "0 of 0" progress bar. Returns null for anything that isn't a finished dry
 * run, so the caller falls back to the normal progress display.
 */
export function dryRunPlanCount(summary: unknown): number | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as { dryRun?: boolean; plan?: unknown[]; skipped?: number };
  if (!s.dryRun) return null;
  if (Array.isArray(s.plan)) return s.plan.length;
  return typeof s.skipped === 'number' ? s.skipped : null;
}

/** Extracted shape of a title-parse dry run's review table, safe to render. */
export interface TitleParseReviewSummary {
  review: TitleParseReviewEntry[];
  reviewTotal: number;
  filledAuthorCount: number;
  filledYearCount: number;
  lowConfidenceCount: number;
}

/**
 * Reads the title-parse dry-run review table off a finished operation's
 * summary — the mechanism a user relies on to confirm that normalising a
 * title never loses author/year data that exists only inside the title
 * string. Returns null for anything that isn't a finished dry run carrying a
 * `review` array (a real run never populates one), so the caller renders
 * nothing instead of an empty table.
 */
export function titleParseReview(summary: unknown): TitleParseReviewSummary | null {
  if (!summary || typeof summary !== 'object') return null;
  const s = summary as Partial<TitleParseRunResult>;
  if (!Array.isArray(s.review)) return null;
  return {
    review: s.review,
    reviewTotal: typeof s.reviewTotal === 'number' ? s.reviewTotal : s.review.length,
    filledAuthorCount: s.filledAuthorCount ?? 0,
    filledYearCount: s.filledYearCount ?? 0,
    lowConfidenceCount: s.lowConfidenceCount ?? 0,
  };
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

/**
 * Review table from a title-parse dry run — the artifact a human reads to
 * confirm nothing is being lost before any write happens (see this file's
 * module docblock and `titleParser.ts`'s). Low-confidence rows are the ones
 * that actually need a look, so they're visually flagged rather than left to
 * blend in with the rest of the table.
 */
function TitleParseReviewView({ review }: { review: TitleParseReviewSummary }) {
  const { review: rows, reviewTotal, filledAuthorCount, filledYearCount, lowConfidenceCount } = review;
  const hiddenCount = reviewTotal - rows.length;

  return (
    <div style={{ marginTop: 16 }}>
      <h4 style={{ margin: '0 0 8px 0' }}>Review</h4>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 12px 0' }}>
        {reviewTotal} book{reviewTotal === 1 ? '' : 's'} parsed — {filledAuthorCount} would gain an author,{' '}
        {filledYearCount} would gain a year, {lowConfidenceCount} landed at low confidence.
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Original title</th>
              <th>Parsed title</th>
              <th>Author on record</th>
              <th>Parsed author</th>
              <th>Parsed year</th>
              <th>Would fill</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr
                key={entry.bookId}
                style={entry.confidence === 'low' ? { background: 'rgba(242, 139, 130, 0.16)' } : undefined}
              >
                <td>{entry.originalTitle}</td>
                <td>{entry.normalizedTitle}</td>
                <td className="muted">{entry.existingAuthor ?? '—'}</td>
                <td>{entry.parsedAuthor ?? '—'}</td>
                <td>{entry.parsedYear ?? '—'}</td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {entry.wouldFill.length > 0 ? entry.wouldFill.join(', ') : '—'}
                </td>
                <td>
                  <span className={`badge ${entry.confidence === 'low' ? 'error' : 'success'}`}>
                    {entry.confidence}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hiddenCount > 0 && (
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0 0' }}>
          Showing {rows.length} of {reviewTotal} — {hiddenCount} more not shown.
        </p>
      )}
    </div>
  );
}

interface RunSectionProps {
  opType: 'enrich' | 'embed' | 'title-parse';
  title: string;
  helperText: string;
  runLabel: string;
  invalidateKeys: string[];
  onRun: (body: {
    dryRun: boolean;
    sample: boolean;
    reparse: boolean;
  }) => Promise<{ operationId: string; status: string }>;
  operationsQuery: ReturnType<typeof useOperations>;
  /** Title-parse and enrichment render something here — their results carry a
   *  `review` table and a `qualityReport`, respectively. Embeddings passes none. */
  renderSummary?: (summary: unknown) => ReactNode;
}

/**
 * One run-control block (checkboxes + run button + live progress +
 * pause/resume/cancel), shared by the title-parse, enrichment, and
 * embeddings sections. Mirrors `pages/Tagging.tsx`'s run-control block.
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
  const [reparse, setReparse] = useState(false);
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
    mutationFn: () => onRun({ dryRun, sample, reparse }),
    onSuccess: (result) => {
      setOpId(result.operationId);
      invalidate(['operations']);
      toast(dryRun ? 'Dry run started' : `${runLabel} started`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const active = op.data ? !isTerminal(op.data.status) : false;
  const progress = op.data?.progress;
  const dryRunPlan = dryRunPlanCount(op.data?.summary);
  const dryRunVerb = opType === 'enrich' ? 'enriched' : opType === 'embed' ? '(re-)embedded' : 'parsed';

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
        {opType === 'title-parse' && (
          <label className="checkbox" title="Books are parsed once by default. Tick this to re-parse the whole library after the parser has improved — it still never overwrites an author or year you already have.">
            <input
              type="checkbox"
              checked={reparse}
              onChange={(e) => setReparse(e.target.checked)}
              disabled={active}
            />
            Re-parse already-parsed books
          </label>
        )}
        <span className="spacer" />
        <button className="btn" onClick={() => run.mutate()} disabled={active || run.isPending}>
          {runLabel}
        </button>
      </div>

      {op.data && (
        <div className="card" style={{ marginTop: 12, background: 'var(--bg-2)' }}>
          <div className="row">
            <span className={`badge ${op.data.status}`}>{op.data.status.toUpperCase()}</span>
            {dryRunPlan != null ? (
              <span className="muted" style={{ fontSize: 13 }}>
                {dryRunPlan} book{dryRunPlan === 1 ? '' : 's'} would be {dryRunVerb}
              </span>
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                {progress?.current ?? 0} of {progress?.total ?? 0}
              </span>
            )}
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

          {dryRunPlan == null && (
            <div style={{ marginTop: 8 }}>
              <ProgressBar current={progress?.current ?? 0} total={progress?.total ?? 0} />
            </div>
          )}

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
 * Run controls for the Phase 3.5 pipeline operations (librarian engine plan)
 * that otherwise only exist as API routes: title parsing
 * (`POST /title-parse/run`), metadata enrichment (`POST /enrichment/run`),
 * and embeddings (`POST /embeddings/run`) — in that order, matching the
 * pipeline's actual sequence (title parsing runs upstream of the other two).
 * Gives them the same dry-run / sample / progress / pause-resume-cancel
 * treatment as tagging, plus — for title parsing, the review table a human
 * needs to confirm nothing is lost, and for enrichment, the quality report
 * needed to decide whether a sample is good enough to trust for a full run.
 */
export function PipelineRunsPanel() {
  const operationsQuery = useOperations();

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ margin: '0 0 16px 0' }}>Pipeline runs</h2>

      <RunSection
        opType="title-parse"
        title="Title parsing"
        helperText="Recovers the real title — plus any author or year — from filename-shaped titles like &quot;24 - Snow Crash - Neal Stephenson - 1992&quot; or &quot;2_ Apt Pupil&quot;, so metadata lookups can actually find the book. The original title is never modified: only empty author and year fields are filled, and a leading number is never written to the series field. Dry run first — it parses every candidate and writes nothing, so the review table below shows exactly what a real run would change."
        runLabel="Run title parsing"
        invalidateKeys={['books', 'operations']}
        onRun={(body) => api.titleParseRun(body)}
        operationsQuery={operationsQuery}
        renderSummary={(summary) => {
          const review = titleParseReview(summary);
          return review ? <TitleParseReviewView review={review} /> : null;
        }}
      />

      <hr style={{ margin: '24px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

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
