/**
 * Calibration assistant for the active control panel (#133).
 *
 * One main action per step: "Calibrate" → move every stick to its ends →
 * "Done, let go" → the bridge measures the rest and stores the result in the
 * site. While the assistant runs the panel drives nothing (the bridge stops
 * any moving axis first). Afterwards each calibrated axis can be tuned: curve
 * (linear / expo with an amount) and invert. The measurement itself is only
 * changed by calibrating again.
 */
import React from 'react';
import type { AxisCalibration, InputCalibrationInfo, InputCalibrationLive } from '../types.ts';

interface Props {
  info: InputCalibrationInfo;
  live: InputCalibrationLive;
  onStart: () => void;
  onCaptureRest: () => void;
  onCancel: () => void;
  onTune: (axis: string, tuning: Partial<Pick<AxisCalibration, 'curve' | 'expo' | 'invert' | 'deadzone'>>) => void;
  onReset: () => void;
}

/** Where the raw value sits in the axis' full range, and how far the sweep has reached. */
function SweepBar({ raw, min, max, full }: { raw: number | null; min: number | null; max: number | null; full: number }) {
  const pct = (v: number) => `${Math.round((v / full) * 100)}%`;
  return (
    <div className="calib-bar" aria-hidden="true">
      {min !== null && max !== null && (
        <div className="calib-bar__reach" style={{ left: pct(min), width: pct(max - min) }} />
      )}
      {raw !== null && <div className="calib-bar__now" style={{ left: pct(raw) }} />}
    </div>
  );
}

export function InputCalibrationPanel({ info, live, onStart, onCaptureRest, onCancel, onTune, onReset }: Props) {
  if (!info.device) return null;
  const calibrated = info.axes.filter((a) => a.calibration);

  if (live.phase === 'sweep' || live.phase === 'rest') {
    const axes = live.axes ?? [];
    return (
      <div className="calib">
        <p className="calib__step">
          {live.phase === 'sweep'
            ? 'Move every stick, trigger and fader to all of its ends. The panel drives nothing meanwhile.'
            : 'Hands off — measuring the rest position…'}
        </p>
        <ul className="calib__axes">
          {axes.map((a) => (
            <li key={a.key} className="calib__axis">
              <span className="calib__label">{a.label}</span>
              <SweepBar raw={a.raw} min={a.min} max={a.max} full={a.full} />
            </li>
          ))}
        </ul>
        <div className="connection-actions">
          <button className="btn btn--primary btn--sm" disabled={live.phase === 'rest'} onClick={onCaptureRest}>
            Done — let go
          </button>
          <button className="btn btn--sm" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="calib">
      <div className="connection-actions">
        <button className="btn btn--primary btn--sm" onClick={onStart}>
          {calibrated.length ? 'Calibrate again' : 'Calibrate joystick'}
        </button>
        {calibrated.length > 0 && (
          <button className="btn btn--sm" onClick={onReset} title="Forget the measured values of this device">Reset</button>
        )}
      </div>
      {live.skipped && live.skipped.length > 0 && (
        <p className="hint">Not moved, kept as before: {live.skipped.join(', ')}</p>
      )}
      {calibrated.length > 0 && (
        <ul className="calib__axes">
          {calibrated.map(({ key, label, calibration: c }) => (
            <li key={key} className="calib__axis calib__axis--tune">
              <span className="calib__label">
                {label}
                <span className="calib__meta">
                  {c!.centre !== undefined ? `${c!.min}–${c!.centre}–${c!.max}` : `${c!.min}→${c!.max}`} · dead zone ±{c!.deadzone}
                </span>
              </span>
              <select
                className="select-group__select"
                aria-label={`${label} response curve`}
                value={c!.curve}
                onChange={(e) => onTune(key, { curve: e.target.value as AxisCalibration['curve'] })}
              >
                <option value="linear">Linear</option>
                <option value="expo">Expo</option>
              </select>
              {c!.curve === 'expo' && (
                <input
                  type="range"
                  className="calib__expo"
                  aria-label={`${label} expo amount`}
                  min={0}
                  max={100}
                  step={5}
                  value={Math.round(c!.expo * 100)}
                  onChange={(e) => onTune(key, { expo: Number(e.target.value) / 100 })}
                />
              )}
              <label className="calib__invert">
                <input type="checkbox" checked={c!.invert} onChange={(e) => onTune(key, { invert: e.target.checked })} />
                Invert
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
