import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import {
  api,
  useEncoderConfig,
  useMutation,
  useOperation,
  type EncodeCandidate,
} from '../../../api';
import { useToast } from '../../../toast';
import { EncoderPageTemplate } from '../templates/EncoderPageTemplate';
import { CandidateTable } from '../organisms/CandidateTable';
import { EncodeConsole } from '../organisms/EncodeConsole';
import { EncodeOptionsForm, type EncodeFormState } from '../molecules/EncodeOptionsForm';

export function EncoderPage() {
  const config = useEncoderConfig();
  const toast = useToast();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [opId, setOpId] = useState<string | null>(null);
  const [form, setForm] = useState<EncodeFormState>({
    dryRun: false,
  });

  const scan = useQuery({
    queryKey: ['encodeScan'],
    queryFn: () => api.encodeScan(true),
    enabled: config.data?.enabled === true,
  });

  const op = useOperation(opId);
  const terminal = op.data && ['completed', 'cancelled', 'error'].includes(op.data.status);

  const candidates = useMemo<EncodeCandidate[]>(() => scan.data?.candidates ?? [], [scan.data]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set(candidates.map((c) => c.libraryItemId)) : new Set());

  const run = useMutation({
    mutationFn: () =>
      api.encodeRun({
        candidates: selected.size > 0 ? [...selected] : undefined,
        dryRun: form.dryRun,
      }),
    onSuccess: (r) => {
      setOpId(r.operationId);
      toast(form.dryRun ? 'Dry run started' : 'Encoding started', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const active = op.data && !terminal;

  if (config.isLoading) return <p className="muted">Loading…</p>;
  if (!config.data?.enabled) {
    return (
      <EncoderPageTemplate title="Encode">
        <div className="card">
          The encoder is disabled. Set <code>ABS_LIBRARY_ID</code> to your ABS library ID, then restart the sidecar.
        </div>
      </EncoderPageTemplate>
    );
  }

  return (
    <EncoderPageTemplate
      title="Encode"
      toolbar={
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn secondary" to="/encode/jobs">
            Job history
          </Link>
          <button className="btn secondary" onClick={() => scan.refetch()} disabled={scan.isFetching}>
            {scan.isFetching ? 'Scanning…' : 'Rescan library'}
          </button>
        </div>
      }
    >
      <div className="card">
        <EncodeOptionsForm
          config={config.data}
          state={form}
          onChange={setForm}
          disabled={Boolean(active)}
        />
        <div className="row" style={{ marginTop: 12 }}>
          <span className="muted">
            {selected.size > 0 ? `${selected.size} selected` : 'All candidates'} ·{' '}
            {candidates.length} book{candidates.length === 1 ? '' : 's'} found
          </span>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => run.mutate()}
            disabled={Boolean(active) || candidates.length === 0}
          >
            {form.dryRun ? 'Preview plan' : 'Start encoding'}
          </button>
        </div>
      </div>

      {opId && <EncodeConsole operationId={opId} />}

      <div className="card" style={{ marginTop: 16 }}>
        <CandidateTable
          candidates={candidates}
          selected={selected}
          onToggle={toggle}
          onToggleAll={toggleAll}
        />
      </div>
    </EncoderPageTemplate>
  );
}
