import { CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useLibraryHealth } from "../../features/curator/api.js";

export function HealthReportPage() {
  const libHealth = useLibraryHealth();

  return (
    <div className="v2-page v2-legacy-surface">
      <div className="v2-page-heading">
        <div>
          <span className="v2-eyebrow">Library Health</span>
          <h1>Diagnostic Report</h1>
          <p>Detailed breakdown of issues identified in your canonical library.</p>
        </div>
      </div>

      {libHealth.isLoading && <p className="v2-muted">Loading health report...</p>}
      {libHealth.data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', marginTop: '2rem' }}>
          
          <div className="v2-card" style={{ display: 'flex', alignItems: 'center', gap: '2rem', padding: '1.5rem' }}>
            <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
              <svg style={{ transform: 'rotate(-90deg)', width: 120, height: 120 }} viewBox="0 0 100 100">
                <circle fill="none" stroke="var(--bg-card)" strokeWidth="8" cx="50" cy="50" r="42" />
                <circle fill="none" stroke="var(--cyan)" strokeWidth="8" strokeLinecap="round" cx="50" cy="50" r="42" style={{ strokeDasharray: `${(libHealth.data.overallScore ?? 0) / 100 * 263.89} 263.89`, transition: 'stroke-dasharray 1s ease-out' }} />
              </svg>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{ fontSize: '2.5rem', fontWeight: 700, lineHeight: 1, color: 'var(--text-primary)' }}>{libHealth.data.overallScore ?? 0}</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--cyan)', fontWeight: 600, marginTop: 4, textTransform: 'uppercase' }}>
                  {(libHealth.data.overallScore ?? 0) >= 90 ? 'Excellent' : (libHealth.data.overallScore ?? 0) >= 75 ? 'Good' : 'Fair'}
                </span>
              </div>
            </div>
            <div>
              <h2 style={{ fontSize: '1.5rem', margin: '0 0 0.5rem 0' }}>Overall Health Score</h2>
              <p style={{ color: 'var(--text-secondary)', margin: 0, maxWidth: '600px' }}>
                Your library health is determined by evaluating completeness of metadata, correct file formats, proper directory structure, and the absence of duplicates.
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            {/* Metadata */}
            <div className="v2-card">
              <div className="v2-card-head">
                <span className="v2-kicker cyan"><CheckCircle2/> Metadata ({libHealth.data.health?.metadata.score ?? 0}%)</span>
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>Books with missing descriptions, tags, or author details.</p>
                <strong className={libHealth.data.health?.metadata.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data.health?.metadata.status}</strong>
              </div>
              <div style={{ marginTop: '1.5rem' }}>
                <Link to="/curate/tags" className="v2-button v2-button-secondary">Review missing tags</Link>
              </div>
            </div>

            {/* Files */}
            <div className="v2-card">
              <div className="v2-card-head">
                <span className="v2-kicker cyan"><CheckCircle2/> Files ({libHealth.data.health?.files.score ?? 0}%)</span>
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>Books encoded in optimized M4B format.</p>
                <strong className={libHealth.data.health?.files.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data.health?.files.status}</strong>
              </div>
              <div style={{ marginTop: '1.5rem' }}>
                <Link to="/curate/encode" className="v2-button v2-button-secondary">Open Encoder</Link>
              </div>
            </div>

            {/* Structure */}
            <div className="v2-card">
              <div className="v2-card-head">
                <span className="v2-kicker cyan"><CheckCircle2/> Structure</span>
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>Items placed outside of their intended canonical folder layout.</p>
                <strong className={libHealth.data.health?.structure.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data.health?.structure.score ?? 0} Issues</strong>
              </div>
              <div style={{ marginTop: '1.5rem' }}>
                <Link to="/process/realign" className="v2-button v2-button-secondary">Review alignment</Link>
              </div>
            </div>

            {/* Duplicates */}
            <div className="v2-card">
              <div className="v2-card-head">
                <span className="v2-kicker cyan"><CheckCircle2/> Duplicates</span>
              </div>
              <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.9rem' }}>Potential duplicate books with matching title and author.</p>
                <strong className={libHealth.data.health?.duplicates.status === 'Attention' ? 'bad' : 'ok'}>{libHealth.data.health?.duplicates.score ?? 0} Duplicates</strong>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
