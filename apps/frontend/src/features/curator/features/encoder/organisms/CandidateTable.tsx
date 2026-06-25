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
  onToggle: (relativeDir: string) => void;
  onToggleAll: (next: boolean) => void;
}) {
  if (candidates.length === 0) {
    return <p className="muted">No encodable folders found. Loose mp3/m4a folders without an existing .m4b appear here.</p>;
  }
  const allSelected = candidates.every((c) => selected.has(c.relativeDir));

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
          <th>Folder</th>
          <th>Files</th>
          <th>Codec</th>
          <th>Duration</th>
          <th>Size</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <CandidateRow
            key={c.relativeDir}
            candidate={c}
            selected={selected.has(c.relativeDir)}
            onToggle={onToggle}
          />
        ))}
      </tbody>
    </table>
  );
}
