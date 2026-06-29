import type { EncodeCandidate } from '../../../api';
import { ByteSize } from '../atoms/ByteSize';

/** Molecule: one selectable candidate folder row. */
export function CandidateRow({
  candidate,
  selected,
  onToggle,
}: {
  candidate: EncodeCandidate;
  selected: boolean;
  onToggle: (libraryItemId: string) => void;
}) {
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(candidate.libraryItemId)}
          aria-label={`Select ${candidate.name}`}
        />
      </td>
      <td>
        <div>{candidate.name}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {candidate.author}
        </div>
      </td>
      <td>{candidate.files.length}</td>
      <td>
        <ByteSize bytes={candidate.totalBytes} />
      </td>
    </tr>
  );
}
