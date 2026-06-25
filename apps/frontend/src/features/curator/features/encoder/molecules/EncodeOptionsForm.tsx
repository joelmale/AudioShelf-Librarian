import type { EncodeMode, EncoderConfig } from '../../../api';

export interface EncodeFormState {
  mode: EncodeMode;
  bitRate: string;
  dryRun: boolean;
  rescanAfter: boolean;
}

/** Molecule: the encode options form (mode, bitrate, dry-run, rescan). */
export function EncodeOptionsForm({
  config,
  state,
  onChange,
  disabled,
}: {
  config: EncoderConfig;
  state: EncodeFormState;
  onChange: (next: EncodeFormState) => void;
  disabled: boolean;
}) {
  const set = (patch: Partial<EncodeFormState>) => onChange({ ...state, ...patch });

  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
      <label className="checkbox">
        Mode
        <select
          value={state.mode}
          disabled={disabled}
          onChange={(e) => set({ mode: e.target.value as EncodeMode })}
          style={{ marginLeft: 8 }}
        >
          <option value="output-dir">output-dir (safe, keeps originals)</option>
          <option value="in-place" disabled={!config.inPlaceAvailable}>
            in-place (replace, backup originals)
          </option>
        </select>
      </label>

      <label className="checkbox">
        Bitrate
        <input
          type="text"
          value={state.bitRate}
          disabled={disabled}
          placeholder="e.g. 64k"
          onChange={(e) => set({ bitRate: e.target.value })}
          style={{ marginLeft: 8, width: 80 }}
        />
      </label>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={state.dryRun}
          disabled={disabled}
          onChange={(e) => set({ dryRun: e.target.checked })}
        />
        Dry run (no encoding)
      </label>

      <label className="checkbox" title={config.rescanAvailable ? '' : 'Set ABS_LIBRARY_ID to enable'}>
        <input
          type="checkbox"
          checked={state.rescanAfter}
          disabled={disabled || !config.rescanAvailable}
          onChange={(e) => set({ rescanAfter: e.target.checked })}
        />
        Trigger ABS rescan when done
      </label>
    </div>
  );
}
