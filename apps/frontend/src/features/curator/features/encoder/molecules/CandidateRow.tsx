import type { EncodeCandidate } from '../../../api';
import { formatDuration } from '../../../api';
import { ByteSize } from '../atoms/ByteSize';
import { CodecChip } from '../atoms/CodecChip';

/** Molecule: one selectable candidate folder row. */
export function CandidateRow({
  candidate,
  selected,
  onToggle,
}: {
  candidate: EncodeCandidate;
  selected: boolean;
  onToggle: (relativeDir: string) => void;
}) {
  return (
    <tr>
      <td>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(candidate.relativeDir)}
          aria-label={`Select ${candidate.name}`}
        />
      </td>
      <td>
        <div>{candidate.name}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {candidate.relativeDir}
        </div>
      </td>
      <td>{candidate.files.length}</td>
      <td>
        <CodecChip probe={candidate.probe} />
      </td>
      <td>{formatDuration(candidate.probe?.durationSeconds ?? null)}</td>
      <td>
        <ByteSize bytes={candidate.totalBytes} />
      </td>
    </tr>
  );
}
