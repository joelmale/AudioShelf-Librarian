import type { EncoderConfig } from '../../../api';

export interface EncodeFormState {
  dryRun: boolean;
}

/** Molecule: the encode options form. */
export function EncodeOptionsForm({
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
        <input
          type="checkbox"
          checked={state.dryRun}
          disabled={disabled}
          onChange={(e) => set({ dryRun: e.target.checked })}
        />
        Dry run (no encoding)
      </label>
    </div>
  );
}
