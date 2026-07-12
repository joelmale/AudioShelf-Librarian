import { useState, useMemo } from 'react';
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
  const [sortField, setSortField] = useState<'book' | 'files' | 'size' | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  const handleSort = (field: 'book' | 'files' | 'size') => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortedCandidates = useMemo(() => {
    if (!sortField) return candidates;
    return [...candidates].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'book') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortField === 'files') {
        cmp = a.files.length - b.files.length;
      } else if (sortField === 'size') {
        cmp = a.totalBytes - b.totalBytes;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [candidates, sortField, sortDirection]);

  if (candidates.length === 0) {
    return <p className="muted">No books need M4B conversion. MP3/M4A items without an existing M4B appear here.</p>;
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
          <th onClick={() => handleSort('book')} style={{ cursor: 'pointer', userSelect: 'none' }}>
            Book {sortField === 'book' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </th>
          <th onClick={() => handleSort('files')} style={{ cursor: 'pointer', userSelect: 'none' }}>
            Files {sortField === 'files' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </th>
          <th onClick={() => handleSort('size')} style={{ cursor: 'pointer', userSelect: 'none' }}>
            Size {sortField === 'size' ? (sortDirection === 'asc' ? '↑' : '↓') : ''}
          </th>
        </tr>
      </thead>
      <tbody>
        {sortedCandidates.map((c) => (
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
