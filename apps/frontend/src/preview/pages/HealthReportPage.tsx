import { CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useLibraryHealth } from "../../features/curator/api.js";

export function HealthReportPage() {
  const libHealth = useLibraryHealth();
  const structureMeasured = libHealth.data?.health?.structure.status !== "Unknown"
    && libHealth.data?.totals.structureIssues != null;

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
          
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'stretch', flexWrap: 'wrap' }}>
            <div className="v2-card" style={{ width: 'min(100%, 280px)', minHeight: 280, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '1.75rem 1.25rem', flexShrink: 0 }}>
              <div style={{ position: 'relative', width: 130, height: 130, margin: '0 auto 1rem' }}>
                <svg style={{ transform: 'rotate(-90deg)', width: 130, height: 130 }} viewBox="0 0 100 100">
                  <circle fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" cx="50" cy="50" r="42" />
                  <circle fill="none" stroke="var(--v2-cyan)" strokeWidth="8" strokeLinecap="round" cx="50" cy="50" r="42" style={{ strokeDasharray: `${(libHealth.data.overallScore ?? 0) / 100 * 263.89} 263.89`, transition: 'stroke-dasharray 1s ease-out' }} />
                </svg>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '2.5rem', fontWeight: 750, lineHeight: 1, color: 'var(--v2-text)' }}>{libHealth.data.overallScore ?? 0}</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--v2-cyan)', fontWeight: 700, marginTop: 4, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {(libHealth.data.overallScore ?? 0) >= 90 ? 'Excellent' : (libHealth.data.overallScore ?? 0) >= 75 ? 'Good' : 'Fair'}
                  </span>
                </div>
              </div>
              <h2 style={{ fontSize: '1.2rem', margin: '0 0 0.35rem 0' }}>Overall Health Score</h2>
              <p style={{ color: 'var(--v2-muted)', margin: 0, fontSize: '0.85rem', lineHeight: 1.4 }}>
                Aggregated library score
              </p>
            </div>
            <div className="v2-card" style={{ flex: '1 1 340px', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '1.75rem' }}>
              <span className="v2-kicker cyan" style={{ marginBottom: '0.5rem' }}>Diagnostics benchmark</span>
              <h3 style={{ fontSize: '1.35rem', margin: '0 0 0.65rem 0' }}>Canonical Library Health</h3>
              <p style={{ color: 'var(--v2-muted)', margin: '0 0 1.25rem 0', lineHeight: 1.55 }}>
                Your library health is determined by evaluating completeness of metadata, correct file formats, proper directory structure, and the absence of duplicates.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '1rem', borderTop: '1px solid var(--v2-line)', paddingTop: '1rem' }}>
                <div>
                  <small style={{ color: 'var(--v2-dim)', display: 'block', fontSize: '0.75rem' }}>Books tracked</small>
                  <strong style={{ fontSize: '1.15rem', color: 'var(--v2-text)' }}>{libHealth.data.totals.books}</strong>
                </div>
                <div>
                  <small style={{ color: 'var(--v2-dim)', display: 'block', fontSize: '0.75rem' }}>Complete metadata</small>
                  <strong style={{ fontSize: '1.15rem', color: 'var(--v2-text)' }}>{libHealth.data.totals.completeMetadata}</strong>
                </div>
                <div>
                  <small style={{ color: 'var(--v2-dim)', display: 'block', fontSize: '0.75rem' }}>M4B files</small>
                  <strong style={{ fontSize: '1.15rem', color: 'var(--v2-text)' }}>{libHealth.data.totals.m4b}</strong>
                </div>
              </div>
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
                <strong className={libHealth.data.health?.structure.status === 'Attention' ? 'bad' : structureMeasured ? 'ok' : ''}>
                  {structureMeasured
                    ? `${libHealth.data.totals.structureIssues} ${libHealth.data.totals.structureIssues === 1 ? "issue" : "issues"}`
                    : "Unknown · not measured"}
                </strong>
              </div>
              <div style={{ marginTop: '1.5rem' }}>
                <Link to="/curate/realign" className="v2-button v2-button-secondary">Review alignment</Link>
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
