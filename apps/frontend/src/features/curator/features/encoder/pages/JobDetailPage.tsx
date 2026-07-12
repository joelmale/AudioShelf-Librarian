import { Link } from 'react-router-dom';

import { useEncodeHistory } from '../../../api';
import { EncoderPageTemplate } from '../templates/EncoderPageTemplate';
import { Badge } from '../atoms/Badge';

/** Page: persisted encode-history (survives restarts; from the encode_history table). */
export function JobDetailPage({ backPath = '/curator/encode' }: { backPath?: string }) {
  const history = useEncodeHistory();

  return (
    <EncoderPageTemplate
      title="Encode History"
      toolbar={
        <Link className="btn secondary" to={backPath}>
          Back to encoder
        </Link>
      }
    >
      <div className="card">
        {history.data && history.data.length === 0 && <p className="muted">No encode history yet.</p>}
        {history.data && history.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Name</th>
                <th>Author</th>
                <th>Size (MB)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((h) => (
                <tr key={h.id}>
                  <td>{new Date(h.startedAt).toLocaleString()}</td>
                  <td>{h.name}</td>
                  <td>{h.author}</td>
                  <td>{(h.totalBytes / 1024 / 1024).toFixed(1)}</td>
                  <td>
                    <Badge status={h.status} />
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
