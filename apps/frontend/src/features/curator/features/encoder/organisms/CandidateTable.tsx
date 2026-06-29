import type { EncodeCandidate } from '../../../api';
import { CandidateRow } from '../molecules/CandidateRow';

/** Organism: the selectable table of scanned candidate folders. */
export function CandidateTable({
  candidates,
  selected,
  onToggle,
  onToggleAll,
}: {
  candidates: EncodeCandidate[];
  selected: Set<string>;
  onToggle: (libraryItemId: string) => void;
  onToggleAll: (next: boolean) => void;
}) {
  if (candidates.length === 0) {
    return <p className="muted">No encodable folders found. Items with multiple loose tracks and no existing M4B appear here.</p>;
  }
  const allSelected = candidates.every((c) => selected.has(c.libraryItemId));

  return (
    <table className="table">
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onToggleAll(e.target.checked)}
              aria-label="Select all"
            />
          </th>
          <th>Book</th>
          <th>Files</th>
          <th>Size</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <CandidateRow
            key={c.libraryItemId}
            candidate={c}
            selected={selected.has(c.libraryItemId)}
            onToggle={onToggle}
          />
        ))}
      </tbody>
    </table>
  );
}
