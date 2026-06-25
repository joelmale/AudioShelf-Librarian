import type { AudioProbe } from '../../../api';

/** Atom: compact codec/bitrate summary from an ffprobe result. */
export function CodecChip({ probe }: { probe: AudioProbe | null }) {
  if (!probe || !probe.codec) return <span className="muted">—</span>;
  const kbps = probe.bitRate ? `${Math.round(probe.bitRate / 1000)}k` : null;
  return (
    <span className="pill genre">
      {probe.codec}
      {kbps ? ` · ${kbps}` : ''}
    </span>
  );
}
