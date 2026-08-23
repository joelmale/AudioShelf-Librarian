import { describe, expect, it } from 'vitest';

import { dryRunPlanCount } from './PipelineRunsPanel.js';

/**
 * Pins the reading of a finished dry run's summary. The bug this guards
 * against was real: a dry-run enrichment over a 958-book library displayed
 * "COMPLETED — 0 of 0", because the dry-run branch returns its plan
 * synchronously and never calls setProgress.
 */
describe('dryRunPlanCount', () => {
  it('reads the plan array length from a finished dry run', () => {
    const summary = { dryRun: true, plan: new Array(958).fill({ bookId: 'x', title: 't', providers: [] }) };
    expect(dryRunPlanCount(summary)).toBe(958);
  });

  it('falls back to skipped when the plan array is absent', () => {
    // The dry-run branch sets skipped to the same count as the plan, so this
    // stays correct if the operation summary ever omits the array itself.
    expect(dryRunPlanCount({ dryRun: true, skipped: 958 })).toBe(958);
  });

  it('prefers the plan array over skipped when both are present', () => {
    expect(dryRunPlanCount({ dryRun: true, plan: [{}, {}], skipped: 99 })).toBe(2);
  });

  it('returns null for a real (non-dry) run so the caller shows progress', () => {
    expect(dryRunPlanCount({ dryRun: false, processed: 44, skipped: 0 })).toBeNull();
    expect(dryRunPlanCount({ processed: 44 })).toBeNull();
  });

  it('returns null for absent or non-object summaries', () => {
    expect(dryRunPlanCount(undefined)).toBeNull();
    expect(dryRunPlanCount(null)).toBeNull();
    expect(dryRunPlanCount('dryRun')).toBeNull();
    expect(dryRunPlanCount(42)).toBeNull();
  });

  it('returns null when a dry run carries neither a plan nor a skipped count', () => {
    expect(dryRunPlanCount({ dryRun: true })).toBeNull();
  });

  it('reports zero when a dry run genuinely has nothing to do', () => {
    // Distinct from null: zero is a real answer ("0 books would be enriched"),
    // null means "this is not a finished dry run, show progress instead".
    expect(dryRunPlanCount({ dryRun: true, plan: [] })).toBe(0);
  });
});
