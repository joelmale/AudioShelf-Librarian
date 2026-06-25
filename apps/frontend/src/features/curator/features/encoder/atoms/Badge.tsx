/** Atom: a status pill. Reuses the global `.badge` design tokens. */
export function Badge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}
