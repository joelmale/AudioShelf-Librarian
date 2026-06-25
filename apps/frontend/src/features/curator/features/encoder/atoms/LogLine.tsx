/** Atom: a single line in the live encode console. */
export function LogLine({ ts, line }: { ts: number; line: string }) {
  return (
    <div className="log-line">
      [{new Date(ts).toLocaleTimeString()}] {line}
    </div>
  );
}
