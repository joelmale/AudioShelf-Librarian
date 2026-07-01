import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import {
  api,
  useEncoderConfig,
  useEncodeLibraries,
  useMutation,
  type EncodeCandidate,
  useEncodeQueue,
} from '../../../api';
import { useToast } from '../../../toast';
import { EncoderPageTemplate } from '../templates/EncoderPageTemplate';
import { CandidateTable } from '../organisms/CandidateTable';
import { EncodeQueueList } from '../organisms/EncodeQueueList';
import { EncodeConsole } from '../organisms/EncodeConsole';

export function EncoderPage() {
  const config = useEncoderConfig();
  const toast = useToast();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedLibraryId, setSelectedLibraryId] = useState<string>('');

  const librariesQuery = useEncodeLibraries();
  const libraries = useMemo(() => librariesQuery.data ?? [], [librariesQuery.data]);

  // Default to the first library if not set
  if (libraries.length > 0 && !selectedLibraryId) {
    setSelectedLibraryId(libraries[0].id);
  }

  const scan = useQuery({
    queryKey: ['encodeScan', selectedLibraryId],
    queryFn: () => api.encodeScan(selectedLibraryId, true),
    enabled: config.data?.enabled === true && Boolean(selectedLibraryId),
  });
  
  const queueQuery = useEncodeQueue();

  const candidates = useMemo<EncodeCandidate[]>(() => scan.data?.candidates ?? [], [scan.data]);
  
  // Filter out candidates that are already in the queue
  const queueIds = new Set(queueQuery.data?.map(q => q.id) ?? []);
  const availableCandidates = candidates.filter(c => !queueIds.has(c.libraryItemId));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(availableCandidates.map((c) => c.libraryItemId)) : new Set());

  const enqueue = useMutation({
    mutationFn: () =>
      api.encodeEnqueue({
        candidates: selected.size > 0 ? [...selected] : availableCandidates.map(c => c.libraryItemId),
        libraryId: selectedLibraryId,
      }),
    onSuccess: (r) => {
      toast(`Added ${r.count} items to the encode queue`, 'success');
      setSelected(new Set());
      queueQuery.refetch();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  if (config.isLoading) return <p className="muted">Loading…</p>;
  if (!config.data?.enabled) {
    return (
      <EncoderPageTemplate title="Encode">
        <div className="card">
          The encoder is disabled. Please ensure the backend is running.
        </div>
      </EncoderPageTemplate>
    );
  }

  return (
    <EncoderPageTemplate
      title="Encode"
      toolbar={
        <div className="row" style={{ gap: 8 }}>
          <select 
            className="input" 
            value={selectedLibraryId} 
            onChange={(e) => setSelectedLibraryId(e.target.value)}
          >
            {libraries.map(lib => (
              <option key={lib.id} value={lib.id}>{lib.name}</option>
            ))}
          </select>
          <Link className="btn secondary" to="/curator/encode/jobs">
            Job history
          </Link>
          <button className="btn secondary" onClick={() => scan.refetch()} disabled={scan.isFetching || !selectedLibraryId}>
            {scan.isFetching ? 'Scanning…' : 'Rescan library'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', alignItems: 'start' }}>
        {/* Left Side: Candidate Selection */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="card">
            <h3 style={{ margin: '0 0 12px 0' }}>Available for Encoding</h3>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="muted">
                {selected.size > 0 ? `${selected.size} selected` : 'All candidates'} ·{' '}
                {availableCandidates.length} book{availableCandidates.length === 1 ? '' : 's'} available
              </span>
              <span className="spacer" />
              <button
                className="btn"
                onClick={() => enqueue.mutate()}
                disabled={enqueue.isPending || availableCandidates.length === 0}
              >
                {enqueue.isPending ? 'Adding...' : 'Add to Queue'}
              </button>
            </div>
          </div>
          
          <div className="card">
            <CandidateTable
              candidates={availableCandidates}
              selected={selected}
              onToggle={toggle}
              onToggleAll={toggleAll}
            />
          </div>
        </div>

        {/* Right Side: Encoding Queue */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <h3 style={{ margin: 0 }}>Encoding Queue</h3>
            {/* The global queue socket console for running jobs */}
            <EncodeConsole operationId="encode_queue" />
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
               <EncodeQueueList queue={queueQuery.data ?? []} />
            </div>
          </div>
        </div>
      </div>
    </EncoderPageTemplate>
  );
}
