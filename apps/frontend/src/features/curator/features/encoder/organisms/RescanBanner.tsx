/**
 * Organism: post-encode banner — confirms the ABS rescan was triggered, or warns
 * the user to run one manually so the new .m4b files are picked up.
 */
export function RescanBanner({ triggered, required }: { triggered?: boolean; required?: boolean }) {
  if (triggered) {
    return (
      <div className="card" style={{ marginTop: 16, borderLeft: '3px solid var(--ok, #2e7d32)' }}>
        ✓ Triggered an ABS library rescan — new audiobooks will appear once ABS finishes scanning.
      </div>
    );
  }
  if (required) {
    return (
      <div className="card" style={{ marginTop: 16, borderLeft: '3px solid var(--warn, #ed6c02)' }}>
        ⚠ Encoding finished. ABS was <strong>not</strong> rescanned — run a library scan in
        Audiobookshelf (or enable “Trigger ABS rescan”) so the new .m4b files are imported.
      </div>
    );
  }
  return null;
}
