import { Link } from 'react-router-dom';

import { useEncodeJobs } from '../../../api';
import { EncoderPageTemplate } from '../templates/EncoderPageTemplate';
import { Badge } from '../atoms/Badge';

/** Page: persisted encode-job history (survives restarts; from the encode_jobs table). */
export function JobDetailPage() {
  const jobs = useEncodeJobs();

  return (
    <EncoderPageTemplate
      title="Encode jobs"
      toolbar={
        <Link className="btn secondary" to="/encode">
          Back to encoder
        </Link>
      }
    >
      <div className="card">
        {jobs.data && jobs.data.length === 0 && <p className="muted">No encode jobs yet.</p>}
        {jobs.data && jobs.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Mode</th>
                <th>Codec</th>
                <th>Progress</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.data.map((j) => (
                <tr key={j.id}>
                  <td>{new Date(j.startedAt).toLocaleString()}</td>
                  <td>{j.mode}</td>
                  <td>
                    {j.audioCodec}
                    {j.bitRate ? ` · ${j.bitRate}` : ''}
                  </td>
                  <td>
                    {j.doneCount}
                    {j.candidateCount > 0 ? ` / ${j.candidateCount}` : ''}
                  </td>
                  <td>
                    <Badge status={j.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </EncoderPageTemplate>
  );
}
