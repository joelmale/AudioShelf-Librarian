/**
 * The metadata pipeline: four stages that must run in dependency order,
 * rendered as one numbered list so the order is visible rather than folklore.
 *
 *   titles -> enrichment -> book_entities --+
 *                                           +-> book card -> card_hash -> embedding
 *   tags -------------------------------------+
 *
 * Title parsing recovers real titles from filename-shaped ones; enrichment
 * turns those titles into entities; tagging adds vocabulary; embeddings
 * encode the finished card. Each stage only ever sees what the stages above
 * it produced, so running one out of order silently does nothing useful.
 *
 * This panel used to hold only the last three, sitting *below* a tagging
 * page that owned the heading, a stat grid and a radial progress ring — so
 * the layout implied tagging came first and the rest were accessories.
 * Every stage now renders through the same `RunSection`, at the same visual
 * weight, numbered in the order they have to run.
 *
 * Three of the stages carry an escape-hatch checkbox: a "skip what's already
 * done" filter keyed on cached state goes stale when the *input* improves
 * rather than ages, and without a way to force the re-run the stage would
 * report zero work forever. Embeddings deliberately has none — see the
 * comment at its RunSection.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  api,
  useInvalidate,
  useMutation,
  useOperation,
  useOperations,
  useTagStats,
  type EnrichmentQualityReport,
  type EnrichmentRunResult,
  type TitleParseReviewEntry,
  type TitleParseRunResult,
} from '../api';
import { useToast } from '../toast';
import { estimateTaggingCost } from '../tagCost';

const TERMINAL_STATUSES = ['completed', 'cancelled', 'error'];

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Operation type and stepper label for each stage, in run order. */
const STAGES = [
  { opType: 'title-parse', short: 'Titles', anchor: 'stage-title-parse' },
  { opType: 'enrich', short: 'Enrich', anchor: 'stage-enrichment' },
  { opType: 'tag', short: 'Tags', anchor: 'stage-tagging' },
  { opType: 'embed', short: 'Embeddings', anchor: 'stage-embeddings' },
] as const;

type StageOpType = (typeof STAGES)[number]['opType'];

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
 * The running action log for one operation. This was tagging's "Live Neural
 * Feed" — a page-level section that existed for tagging alone, and a good
 * part of why tagging read as the main event rather than stage three. Action
 * logs are per-operation, not per-type, so every stage gets one, collapsed
 * once the run finishes.
 */
function OperationLogFeed({ opId, active }: { opId: string; active: boolean }) {
  const feedRef = useRef<HTMLDivElement>(null);

  const logs = useQuery({
    queryKey: ['actionLogs', opId],
    queryFn: () => api.actionLogs({ operationId: opId, limit: '200' }),
    refetchInterval: active ? 1000 : false,
  });

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [logs.data]);

  const lines = logs.data ?? [];
  if (lines.length === 0) return null;

  return (
    <details className="pipeline-log" open={active}>
      <summary>
        Live log
        {active && <span className="pipeline-log-dot" />}
      </summary>
      <div className="live-neural-feed" ref={feedRef}>
        {lines.map((l, i) => {
          let levelClass = 'info';
          if (l.level === 'error') levelClass = 'error';
          else if (l.level === 'warn') levelClass = 'warn';
          else if (/success|completed|saved/i.test(l.message)) levelClass = 'success';

          return (
            <div key={i} className={`neural-line ${levelClass}`}>
              <span className="neural-time">
                [
                {new Date(l.ts).toLocaleTimeString([], {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
                ]
              </span>
              <span className="neural-event">[{l.event}]</span>
              <span className="neural-msg">{l.message}</span>
            </div>
          );
        })}
      </div>
    </details>
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
        {' '}
        <strong>{entityCoverage.withNotableEntities}</strong> with notable entities
        ({entityCoverage.avgNotablePerBook.toFixed(1)} avg/book) — notable is the
        high-precision subset that reaches the book card; the rest still validate tags.
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
                  {ex.entities.length === 0
                    ? '—'
                    : ex.entities.map((e, i) => (
                        <span key={`${e.kind}:${e.entity}`}>
                          {i > 0 && ', '}
                          {/* Non-notable entities are dimmed rather than hidden:
                              seeing WHAT was demoted is the point of this view. */}
                          <span style={{ opacity: e.notable ? 1 : 0.45 }}>{e.entity}</span>
                        </span>
                      ))}
                  {ex.entityCounts.total > ex.entities.length && (
                    <span style={{ opacity: 0.6 }}>
                      {' '}(+{ex.entityCounts.total - ex.entities.length} more)
                    </span>
                  )}
                  {ex.entityCounts.total > 0 && (
                    <div style={{ opacity: 0.6, marginTop: 2 }}>
                      {ex.entityCounts.notable} of {ex.entityCounts.total} notable
                    </div>
                  )}
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

/** The run body every stage posts. Each optional flag belongs to exactly one
 *  stage; `RunSection` sets whichever one its `extraOption` names. */
interface RunBody {
  dryRun: boolean;
  sample: boolean;
  reparse?: boolean;
  refresh?: boolean;
  retagAll?: boolean;
}

/**
 * One stage's extra checkbox. `key` selects which field of the run body it
 * sets; `help` is a one-line, always-visible explanation — these are
 * non-obvious and, for `refresh` and `retagAll`, expensive, so a hover-only
 * tooltip isn't enough.
 */
interface ExtraOption {
  key: 'reparse' | 'refresh' | 'retagAll';
  label: string;
  help: string;
}

interface RunSectionProps {
  /** 1-based position in the pipeline, rendered as the stage's number. */
  step: number;
  /** Scroll target for the stepper at the top of the panel. */
  anchor: string;
  opType: StageOpType;
  title: string;
  helperText: string;
  /** A string, or — where the extra checkbox changes what the button does —
   *  a function of that checkbox's state. */
  runLabel: string | ((extraChecked: boolean) => string);
  invalidateKeys: string[];
  onRun: (body: RunBody) => Promise<{ operationId: string; status: string }>;
  operationsQuery: ReturnType<typeof useOperations>;
  /** What this stage currently has to do, e.g. "946 books to tag — ~$4.60".
   *  Only tagging can answer this today; the others need per-stage pending
   *  counts from the API before they can. */
  statusLine?: (extraChecked: boolean) => ReactNode;
  /** Shown above the controls when running this stage now would waste work —
   *  e.g. embedding before an outstanding retag. Never blocks the run. */
  notice?: ReactNode;
  /** Title-parse and enrichment render something here — their results carry a
   *  `review` table and a `qualityReport`, respectively. Tagging and
   *  embeddings pass none. */
  renderSummary?: (summary: unknown) => ReactNode;
  extraOption?: ExtraOption;
  /** Disables the run button when there is provably nothing to do. */
  runDisabled?: (extraChecked: boolean) => boolean;
}

/**
 * One stage: number, heading, what it does, what it has to do, controls,
 * live progress, log feed, and whatever review artifact the run produced.
 * Every stage renders through this — that sameness is what makes the
 * numbering read as an order rather than a coincidence.
 */
function RunSection({
  step,
  anchor,
  opType,
  title,
  helperText,
  runLabel,
  invalidateKeys,
  onRun,
  operationsQuery,
  statusLine,
  notice,
  renderSummary,
  extraOption,
  runDisabled,
}: RunSectionProps) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [dryRun, setDryRun] = useState(false);
  const [sample, setSample] = useState(false);
  const [extraChecked, setExtraChecked] = useState(false);
  // Tracked explicitly (rather than re-derived from the operations list every
  // render) so a finished run's quality report stays on screen instead of
  // disappearing once the op drops out of the "active" list.
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

  const label = typeof runLabel === 'function' ? runLabel(extraChecked) : runLabel;

  const run = useMutation({
    mutationFn: () => onRun({ dryRun, sample, ...(extraOption ? { [extraOption.key]: extraChecked } : {}) }),
    onSuccess: (result) => {
      setOpId(result.operationId);
      invalidate(['operations']);
      toast(dryRun ? 'Dry run started' : `${label} started`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const active = op.data ? !isTerminal(op.data.status) : false;
  const progress = op.data?.progress;
  const dryRunPlan = dryRunPlanCount(op.data?.summary);
  const dryRunVerb =
    opType === 'enrich'
      ? 'enriched'
      : opType === 'embed'
        ? '(re-)embedded'
        : opType === 'tag'
          ? 'tagged'
          : 'parsed';

  return (
    <section className="pipeline-stage" id={anchor} aria-labelledby={`${anchor}-title`}>
      <div className="pipeline-stage-head">
        <span className="pipeline-stage-num" aria-hidden="true">
          {step}
        </span>
        <h3 id={`${anchor}-title`}>{title}</h3>
      </div>

      <p className="muted pipeline-stage-help">{helperText}</p>
      {statusLine && <p className="pipeline-stage-status">{statusLine(extraChecked)}</p>}
      {notice && <p className="pipeline-stage-notice">{notice}</p>}

      <div className="row">
        <label className="checkbox">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} disabled={active} />
          Dry run (no calls)
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} disabled={active} />
          Sample only (max 20 or 5%)
        </label>
        {extraOption && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={extraChecked}
              onChange={(e) => setExtraChecked(e.target.checked)}
              disabled={active}
            />
            {extraOption.label}
          </label>
        )}
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => run.mutate()}
          disabled={active || run.isPending || (runDisabled ? runDisabled(extraChecked) : false)}
        >
          {label}
        </button>
      </div>

      {extraOption && (
        <p className="muted" style={{ fontSize: 12, margin: '4px 0 0 0' }}>
          {extraOption.help}
        </p>
      )}

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

          {opId && <OperationLogFeed opId={opId} active={active} />}

          {!active && renderSummary && op.data.summary != null ? renderSummary(op.data.summary) : null}
        </div>
      )}
    </section>
  );
}

/**
 * The order, at a glance. Each node scrolls to its stage; a stage with a run
 * in flight is highlighted, so a long page still shows where the work is.
 */
function PipelineStepper({ activeOpTypes }: { activeOpTypes: Set<string> }) {
  const goTo = (anchor: string) => {
    document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav className="pipeline-stepper" aria-label="Pipeline stages">
      {STAGES.map((stage, i) => (
        <span key={stage.opType} className="pipeline-stepper-item">
          <button
            type="button"
            className={`pipeline-stepper-node${activeOpTypes.has(stage.opType) ? ' running' : ''}`}
            onClick={() => goTo(stage.anchor)}
          >
            <span className="pipeline-stepper-num">{i + 1}</span>
            <span>{stage.short}</span>
          </button>
          {i < STAGES.length - 1 && (
            <span className="pipeline-stepper-arrow" aria-hidden="true">
              →
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * The whole pipeline, in run order. Backed by four API routes that otherwise
 * only exist as endpoints: `POST /title-parse/run`, `POST /enrichment/run`,
 * `POST /tags/run` (or `/tags/retag-all`), and `POST /embeddings/run`.
 */
export function PipelineRunsPanel() {
  const operationsQuery = useOperations();
  const stats = useTagStats();

  const activeOpTypes = new Set(
    (operationsQuery.data ?? []).filter((o) => !isTerminal(o.status)).map((o) => o.type)
  );

  const totalBooks = stats.data?.totalBooks ?? 0;
  const untagged = stats.data?.untaggedBooks ?? 0;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ margin: 0 }}>Run in this order</h2>
      <p className="muted" style={{ fontSize: 13, margin: '4px 0 0 0' }}>
        Each stage consumes what the ones above it produced. Running one out of order is not harmful — it just finds
        nothing to do, or does work you will have to redo.
      </p>

      <PipelineStepper activeOpTypes={activeOpTypes} />

      <RunSection
        step={1}
        anchor="stage-title-parse"
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
        extraOption={{
          key: 'reparse',
          label: 'Re-parse already-parsed books',
          help: 'Only needed after the parser itself changes — books are parsed once by default, so a plain re-run finds nothing to do. Still never overwrites an author or year you already have.',
        }}
      />

      <hr className="pipeline-rule" />

      <RunSection
        step={2}
        anchor="stage-enrichment"
        opType="enrich"
        title="Metadata enrichment"
        helperText="Fetches missing metadata from Open Library and Audnexus and rebuilds character/place/time entities — the step that turns a title into the entities a book card carries. Sample is the recommended first step: it is a real run over a handful of books, cheap enough to check provider hit rates and entity coverage before committing to the full library."
        runLabel="Run enrichment"
        invalidateKeys={['books', 'operations']}
        onRun={(body) => api.enrichmentRun(body)}
        operationsQuery={operationsQuery}
        renderSummary={(summary) => {
          const result = summary as EnrichmentRunResult;
          return result.qualityReport ? <QualityReportView report={result.qualityReport} /> : null;
        }}
        extraOption={{
          key: 'refresh',
          label: 'Re-check every book (ignore cache)',
          help: 'Only needed after titles change — the cache is keyed on the book, not the query, so a fixed title can leave a stale "not found" cached forever. Expensive: re-fetches every book from external providers.',
        }}
      />

      <hr className="pipeline-rule" />

      <RunSection
        step={3}
        anchor="stage-tagging"
        opType="tag"
        title="Tagging"
        helperText="Asks the model for vocabulary tags — genre, mood, theme, pacing — grounded against the entities enrichment produced. The only stage that costs money, so it is the one worth dry-running and sampling first."
        runLabel={(retagAll) => (retagAll ? 'Retag entire library' : 'Tag all untagged')}
        invalidateKeys={['tagStats', 'books', 'vocabulary', 'operations']}
        onRun={(body) =>
          body.retagAll
            ? api.retagAll({ dryRun: body.dryRun, sample: body.sample })
            : api.tagRun({ dryRun: body.dryRun, sample: body.sample })
        }
        operationsQuery={operationsQuery}
        statusLine={(retagAll) => {
          const count = retagAll ? totalBooks : untagged;
          const estimate = estimateTaggingCost(count, stats.data?.avgTagTokens ?? null);
          return (
            <>
              <strong>{count}</strong> book{count === 1 ? '' : 's'} to tag — about <strong>{estimate.cost}</strong>{' '}
              <span className="muted">({estimate.detail})</span>. {stats.data?.taggedBooks ?? 0} of {totalBooks} tagged
              so far.
            </>
          );
        }}
        runDisabled={(retagAll) => (retagAll ? totalBooks : untagged) === 0}
        extraOption={{
          key: 'retagAll',
          label: 'Retag all books (clears existing tags first)',
          help: 'Needed after the vocabulary or the tagging prompt changes — books are tagged once by default, so a plain run only picks up untagged ones. Expensive: every book goes back to the model.',
        }}
      />

      <hr className="pipeline-rule" />

      {/*
       * No extraOption here: title-parse, enrichment and tagging all use a
       * "skip what's already done" filter keyed on cached state, which goes
       * stale when the *input* improves rather than ages (see this file's
       * module docblock). Embeddings' `getStaleEmbeddings` selector doesn't
       * have that problem — it compares each book's current card_hash
       * against the embedded one, so a changed card is detected directly
       * rather than inferred from a timestamp, and there's nothing an escape
       * hatch would need to force. That is also why it goes last: it picks
       * up changes from every stage above it on its own.
       */}
      <RunSection
        step={4}
        anchor="stage-embeddings"
        opType="embed"
        title="Embeddings"
        helperText="Re-embeds each active book's composed card via the configured Ollama model. Driven by card_hash staleness, so it needs no force option and an unchanged library costs zero embed calls on re-run. Sample is the recommended first step."
        runLabel="Run embeddings"
        invalidateKeys={['operations']}
        onRun={(body) => api.embeddingsRun(body)}
        operationsQuery={operationsQuery}
        notice={
          untagged > 0 ? (
            <>
              {untagged} book{untagged === 1 ? '' : 's'} still {untagged === 1 ? 'has' : 'have'} no tags. Embedding now
              works, but those cards change once stage 3 runs and will need re-embedding.
            </>
          ) : null
        }
      />
    </div>
  );
}
