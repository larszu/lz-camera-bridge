import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Touch-first PTZ control panel, modelled on the Panasonic AW-RP150:
 * a pan/tilt joystick with speed control, a zoom rocker, focus near/far +
 * one-push AF, an iris strip and a paged preset grid (up to 100 presets)
 * with a store mode — all driven with pointer events so it works equally
 * with touch and mouse.
 *
 * Commands emitted (must match the bridge backends):
 *   ptz          { pan: -100..100, tilt: -100..100 }   (0/0 = stop)
 *   setZoom      { value: -100..100 }                  (0 = stop)
 *   setFocus     { value: -100..100 }                  (0 = stop)
 *   autoFocus    {}
 *   setIris      { value: 0..255 }
 *   recallPreset { value: n } / storePreset { value: n }
 */

interface PtzPanelProps {
  cameraId?: number;
  disabled?: boolean;
  onCommand: (cmd: string, params: Record<string, unknown>) => void;
}

const PRESETS_PER_PAGE = 12;
const PRESET_PAGES = 9; // presets 1..108, AW-RP150-like "100 presets"
const DRIVE_INTERVAL_MS = 120; // resend rate while joystick/rocker held

export function PtzPanel({ cameraId = 1, disabled = false, onCommand }: PtzPanelProps) {
  const [ptSpeed, setPtSpeed] = useState(70); // % speed scale like the RP150 PT SPEED dial
  const [storeMode, setStoreMode] = useState(false);
  const [presetPage, setPresetPage] = useState(0);
  const [activePreset, setActivePreset] = useState<number | null>(null);
  const [iris, setIris] = useState(128);

  const cmd = useCallback(
    (c: string, params: Record<string, unknown> = {}) => {
      if (!disabled) onCommand(c, params);
    },
    [disabled, onCommand],
  );

  /* ── Joystick ─────────────────────────────────────────────────────────── */
  const padRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState({ x: 0, y: 0 }); // -1..1 visual position
  const driveRef = useRef({ pan: 0, tilt: 0, active: false });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendDrive = useCallback(() => {
    const d = driveRef.current;
    cmd('ptz', { pan: Math.round(d.pan), tilt: Math.round(d.tilt) });
  }, [cmd]);

  const startDriveLoop = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(() => {
      if (driveRef.current.active) sendDrive();
    }, DRIVE_INTERVAL_MS);
  }, [sendDrive]);

  const stopDriveLoop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => stopDriveLoop(), [stopDriveLoop]);

  const updateStick = useCallback(
    (clientX: number, clientY: number) => {
      const pad = padRef.current;
      if (!pad) return;
      const rect = pad.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const r = rect.width / 2;
      let x = (clientX - cx) / r;
      let y = (clientY - cy) / r;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      setStick({ x, y });
      driveRef.current = {
        pan: x * ptSpeed,
        tilt: -y * ptSpeed, // up = positive tilt
        active: true,
      };
    },
    [ptSpeed],
  );

  const onPadDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      updateStick(e.clientX, e.clientY);
      sendDrive();
      startDriveLoop();
    },
    [disabled, updateStick, sendDrive, startDriveLoop],
  );

  const onPadMove = useCallback(
    (e: React.PointerEvent) => {
      if (driveRef.current.active) updateStick(e.clientX, e.clientY);
    },
    [updateStick],
  );

  const releasePad = useCallback(() => {
    if (!driveRef.current.active) return;
    driveRef.current = { pan: 0, tilt: 0, active: false };
    setStick({ x: 0, y: 0 });
    stopDriveLoop();
    cmd('ptz', { pan: 0, tilt: 0 }); // explicit stop
  }, [cmd, stopDriveLoop]);

  /* ── Hold-to-drive helper (zoom rocker / focus) ───────────────────────── */
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const holdStart = useCallback(
    (command: string, value: number) => {
      if (disabled) return;
      cmd(command, { value });
      if (holdTimer.current) clearInterval(holdTimer.current);
      holdTimer.current = setInterval(() => cmd(command, { value }), DRIVE_INTERVAL_MS);
    },
    [cmd, disabled],
  );
  const holdStop = useCallback(
    (command: string) => {
      if (holdTimer.current) {
        clearInterval(holdTimer.current);
        holdTimer.current = null;
      }
      cmd(command, { value: 0 }); // stop
    },
    [cmd],
  );
  useEffect(
    () => () => {
      if (holdTimer.current) clearInterval(holdTimer.current);
    },
    [],
  );

  /* ── Presets ──────────────────────────────────────────────────────────── */
  const pressPreset = useCallback(
    (n: number) => {
      setActivePreset(n);
      if (storeMode) {
        cmd('storePreset', { value: n });
        setStoreMode(false);
      } else {
        cmd('recallPreset', { value: n });
      }
    },
    [cmd, storeMode],
  );

  const firstPreset = presetPage * PRESETS_PER_PAGE + 1;

  return (
    <div className={`ptz-panel ${disabled ? 'ptz-panel--disabled' : ''}`}>
      {/* Header */}
      <div className="ptz-panel__header">
        <span className="ptz-panel__title">PTZ CONTROL</span>
        <span className="ptz-panel__cam">CAM {cameraId}</span>
      </div>

      <div className="ptz-panel__body">
        {/* Left column: presets (RP150 preset page + grid) */}
        <div className="ptz-presets">
          <div className="ptz-presets__head">
            <span>PRESET {firstPreset}–{firstPreset + PRESETS_PER_PAGE - 1}</span>
            <div className="ptz-presets__pager">
              <button
                className="ptz-btn ptz-btn--sm"
                onClick={() => setPresetPage((p) => Math.max(0, p - 1))}
                disabled={disabled || presetPage === 0}
              >
                ◀
              </button>
              <button
                className="ptz-btn ptz-btn--sm"
                onClick={() => setPresetPage((p) => Math.min(PRESET_PAGES - 1, p + 1))}
                disabled={disabled || presetPage === PRESET_PAGES - 1}
              >
                ▶
              </button>
            </div>
          </div>
          <div className="ptz-presets__grid">
            {Array.from({ length: PRESETS_PER_PAGE }, (_, i) => {
              const n = firstPreset + i;
              return (
                <button
                  key={n}
                  className={`ptz-preset ${activePreset === n ? 'ptz-preset--active' : ''} ${storeMode ? 'ptz-preset--store' : ''}`}
                  onClick={() => pressPreset(n)}
                  disabled={disabled}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <button
            className={`ptz-btn ptz-btn--store ${storeMode ? 'ptz-btn--store-armed' : ''}`}
            onClick={() => setStoreMode((s) => !s)}
            disabled={disabled}
          >
            {storeMode ? 'STORE: pick a slot…' : 'STORE'}
          </button>
        </div>

        {/* Center: joystick */}
        <div className="ptz-stick">
          <div
            ref={padRef}
            className="ptz-stick__pad"
            onPointerDown={onPadDown}
            onPointerMove={onPadMove}
            onPointerUp={releasePad}
            onPointerCancel={releasePad}
            onLostPointerCapture={releasePad}
          >
            <div className="ptz-stick__cross ptz-stick__cross--h" />
            <div className="ptz-stick__cross ptz-stick__cross--v" />
            <div
              className="ptz-stick__knob"
              style={{ transform: `translate(${stick.x * 42}%, ${stick.y * 42}%)` }}
            />
          </div>
          <label className="ptz-speed">
            PT SPEED
            <input
              type="range"
              min={10}
              max={100}
              value={ptSpeed}
              onChange={(e) => setPtSpeed(Number(e.target.value))}
              disabled={disabled}
            />
            <span>{ptSpeed}%</span>
          </label>
        </div>

        {/* Right column: zoom rocker, focus, iris */}
        <div className="ptz-right">
          <div className="ptz-rocker">
            <span className="ptz-rocker__label">ZOOM</span>
            <button
              className="ptz-rocker__btn"
              onPointerDown={() => holdStart('setZoom', 70)}
              onPointerUp={() => holdStop('setZoom')}
              onPointerLeave={() => holdStop('setZoom')}
              onPointerCancel={() => holdStop('setZoom')}
              disabled={disabled}
            >
              T
            </button>
            <button
              className="ptz-rocker__btn"
              onPointerDown={() => holdStart('setZoom', -70)}
              onPointerUp={() => holdStop('setZoom')}
              onPointerLeave={() => holdStop('setZoom')}
              onPointerCancel={() => holdStop('setZoom')}
              disabled={disabled}
            >
              W
            </button>
          </div>

          <div className="ptz-rocker">
            <span className="ptz-rocker__label">FOCUS</span>
            <button
              className="ptz-rocker__btn"
              onPointerDown={() => holdStart('setFocus', 60)}
              onPointerUp={() => holdStop('setFocus')}
              onPointerLeave={() => holdStop('setFocus')}
              onPointerCancel={() => holdStop('setFocus')}
              disabled={disabled}
            >
              NEAR
            </button>
            <button
              className="ptz-rocker__btn"
              onPointerDown={() => holdStart('setFocus', -60)}
              onPointerUp={() => holdStop('setFocus')}
              onPointerLeave={() => holdStop('setFocus')}
              onPointerCancel={() => holdStop('setFocus')}
              disabled={disabled}
            >
              FAR
            </button>
            <button className="ptz-btn ptz-btn--af" onClick={() => cmd('autoFocus')} disabled={disabled}>
              PUSH AF
            </button>
          </div>

          <label className="ptz-iris">
            IRIS
            <input
              type="range"
              min={0}
              max={255}
              value={iris}
              onChange={(e) => {
                const v = Number(e.target.value);
                setIris(v);
                cmd('setIris', { value: v });
              }}
              disabled={disabled}
            />
            <span>{Math.round((iris / 255) * 100)}%</span>
          </label>
        </div>
      </div>
    </div>
  );
}
