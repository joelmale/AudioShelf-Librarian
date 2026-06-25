/** Atom: a determinate progress bar. Reuses the global `.progress` tokens. */
export function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}
