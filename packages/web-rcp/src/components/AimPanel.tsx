import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeConfig } from '../types.ts';
import { panoramaUrl, videoUrl, type CameraSlot, type JobProgress, type PanoramaMeta, type Pose } from '../hooks/useBridge.ts';

/**
 * Aim by frame (#137) and the panorama map (#138).
 *
 * One thing to do in either view: draw a frame where the shot should be. In
 * "Live" the frame is drawn in the camera's own picture, measured from the
 * pose the head reports now; in "Panorama" it is drawn on the wide map the
 * bridge stitched from a scan — usable even while the camera stands at full
 * tele, with the live picture shown in its place on the map.
 *
 * A click without dragging recentres at the current zoom. The geometry and
 * the zoom curve live in the bridge (protocol/frameAim.ts); this panel only
 * sends where the frame was drawn.
 */

type Frame = { x: number; y: number; w: number; h: number };
type Source = 'picture' | 'panorama';

interface Props {
  cam: CameraSlot;
  connected: boolean;
  pose?: Pose;
  panorama?: PanoramaMeta | null;
  panoramaProgress?: JobProgress;
  fovProgress?: JobProgress;
  onAim: (source: Source, frame: Frame, aspect?: number) => void;
  onScan: () => void;
  onCancel: () => void;
  onGetPanorama: () => void;
  onReadPose: () => void;
  onCalibrate: () => void;
  onSetConfig: (cfg: Partial<BridgeConfig>) => void;
}

const FRAME_ASPECT = 16 / 9;
const RAD = Math.PI / 180;
const JOB_RUNNING = new Set(['starting', 'picture', 'point']);

/** Where the live picture sits on the map (same as `frameOnMap` in the bridge). */
function liveOnMap(pose: Pose, hfov: number, aspect: number, m: PanoramaMeta): Frame {
  const vfov = (2 * Math.atan(Math.tan((hfov * RAD) / 2) / aspect)) / RAD;
  const wDeg = Math.min(360, hfov / Math.max(0.2, Math.cos(pose.tilt * RAD)));
  const span = m.panMax - m.panMin;
  const tspan = m.tiltMax - m.tiltMin;
  return { x: (pose.pan - wDeg / 2 - m.panMin) / span, y: (m.tiltMax - pose.tilt - vfov / 2) / tspan, w: wDeg / span, h: vfov / tspan };
}

const pct = (f: Frame): React.CSSProperties => ({ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` });

function fitLabel(fit?: string): string {
  if (fit === 'table') return 'field of view measured';
  if (fit === 'focal') return 'field of view from focal length';
  if (fit === 'linear') return 'field of view estimated';
  return 'field of view unknown';
}

export function AimPanel(props: Props) {
  const { cam, connected, pose, panorama, panoramaProgress: scan, fovProgress: cal } = props;
  const num = cam.cameraNumber;
  const hasStream = Boolean(cam.config.streamUrl);
  const [source, setSource] = useState<Source>('picture');
  const scanning = !!scan && JOB_RUNNING.has(scan.step) && Date.now() - scan.at < 60000;
  const calibrating = !!cal && JOB_RUNNING.has(cal.step) && Date.now() - cal.at < 60000;

  // The parent passes fresh arrow functions each render; the effects must not re-run on that.
  const calls = useRef(props);
  calls.current = props;
  useEffect(() => { calls.current.onGetPanorama(); }, [num]);
  // The map shows where the live picture is, so it needs the pose — read it while the map is open.
  useEffect(() => {
    if (!connected) return;
    calls.current.onReadPose();
    if (source !== 'panorama') return;
    const t = setInterval(() => calls.current.onReadPose(), 1500);
    return () => clearInterval(t);
  }, [connected, source, num]);

  return (
    <div className="panel aim" style={{ marginTop: 16 }}>
      <div className="headline" style={{ marginBottom: 8 }}>
        <span className="headline__kicker">Aim</span>
        <span className="headline__title">Draw the next shot</span>
        <span className="headline__meta">
          <span className="aim__tabs" role="tablist" aria-label="Draw in">
            {(['picture', 'panorama'] as Source[]).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={source === s}
                className={`btn btn--sm ${source === s ? 'aim__tab--on' : ''}`}
                onClick={() => setSource(s)}
              >
                {s === 'picture' ? 'Live' : 'Panorama'}
              </button>
            ))}
          </span>
          <span className={`chip ${pose?.fovFit === 'table' || pose?.fovFit === 'focal' ? 'chip--on' : pose?.fovFit ? '' : 'chip--warn'}`}>
            {fitLabel(pose?.fovFit)}
          </span>
        </span>
      </div>

      {source === 'picture' && (
        hasStream ? (
          <Stage
            disabled={!connected}
            image={`${videoUrl(num)}`}
            onFrame={(f, aspect) => props.onAim('picture', f, aspect)}
            clickWidth={() => 1}
          />
        ) : (
          <div className="empty">This camera has no stream address. Add one in the connection panel to draw in its picture.</div>
        )
      )}

      {source === 'panorama' && (
        panorama ? (
          <Stage
            disabled={!connected || scanning}
            image={panoramaUrl(num, panorama.createdAt)}
            onFrame={(f) => props.onAim('panorama', f)}
            clickWidth={() => (pose?.hfovDeg ? Math.min(1, pose.hfovDeg / (panorama.panMax - panorama.panMin)) : 0.1)}
            live={pose?.hfovDeg && hasStream ? { frame: liveOnMap(pose, pose.hfovDeg, panorama.aspect || FRAME_ASPECT, panorama), src: videoUrl(num) } : undefined}
          />
        ) : (
          <div className="empty">
            No panorama yet. The camera steps across the room at wide zoom and the bridge stitches the pictures into one map.
            <br />
            <button className="btn btn--primary" disabled={!connected || !hasStream || scanning} onClick={props.onScan}>
              {scanning ? 'Scanning…' : 'Scan panorama'}
            </button>
          </div>
        )
      )}

      {scanning && (
        <div className="row" style={{ marginTop: 8 }}>
          <progress max={scan!.total ?? 1} value={scan!.index ?? 0} style={{ flex: 1 }} aria-label="Panorama scan" />
          <span className="hint">
            {scan!.index && scan!.total ? (scan!.index >= scan!.total ? 'stitching…' : `picture ${scan!.index} of ${scan!.total}`) : 'starting…'}
          </span>
          <button className="btn btn--sm" onClick={props.onCancel}>Cancel</button>
        </div>
      )}
      {scan && !scanning && scan.step !== 'done' && Date.now() - scan.at < 120000 && (
        <p className="hint" role="status">Scan {scan.step}{scan.message ? `: ${scan.message}` : ''}</p>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <span className="hint" style={{ flex: 1 }}>
          {source === 'picture'
            ? 'Drag a frame in the picture: the head pans, tilts and zooms to it. A click recentres.'
            : panorama
              ? `Drag a frame on the map — also while the camera is at tele. Map: ${panorama.pictures} pictures, ${new Date(panorama.createdAt).toLocaleString()}.`
              : 'Scan once; scan again when the room has changed.'}
        </span>
        {source === 'panorama' && panorama && (
          <button className="btn btn--sm" disabled={!connected || !hasStream || scanning} onClick={props.onScan} title="The map is a still: scan again when the room has changed">
            Scan again
          </button>
        )}
      </div>

      <FovSettings config={cam.config} connected={connected && hasStream} busy={calibrating || scanning} progress={cal} onCalibrate={props.onCalibrate} onSetConfig={props.onSetConfig} />
    </div>
  );
}

interface StageProps {
  image: string;
  disabled: boolean;
  onFrame: (frame: Frame, imageAspect: number) => void;
  /** Width of the frame a plain click makes, 0..1 of the picture. */
  clickWidth: () => number;
  live?: { frame: Frame; src: string };
}

/** A picture with a frame tool on top. The frame keeps the camera's 16:9. */
function Stage({ image, disabled, onFrame, clickWidth, live }: StageProps) {
  const box = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Frame | null>(null);
  const [sent, setSent] = useState<Frame | null>(null);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), 2500);
    return () => clearTimeout(t);
  }, [sent]);

  const point = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), r };
  };

  /** Frame from the start point to `p`, 16:9 in screen pixels, growing from the start corner. */
  const frameTo = useCallback((p: { x: number; y: number; r: DOMRect }): Frame => {
    const s = start.current!;
    const wPx = Math.abs(p.x - s.x) * p.r.width;
    const hPx = Math.max(wPx / FRAME_ASPECT, Math.abs(p.y - s.y) * p.r.height);
    const w = (hPx * FRAME_ASPECT) / p.r.width;
    const h = hPx / p.r.height;
    return { x: p.x >= s.x ? s.x : s.x - w, y: p.y >= s.y ? s.y : s.y - h, w, h };
  }, []);

  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    start.current = { x: p.x, y: p.y };
    setDrag(null);
  };
  const move = (e: React.PointerEvent) => {
    if (!start.current) return;
    setDrag(frameTo(point(e)));
  };
  const up = (e: React.PointerEvent) => {
    if (!start.current) return;
    const p = point(e);
    let f = frameTo(p);
    if (f.w * p.r.width < 12) {
      // A click: recentre with a frame of the current width.
      const w = clickWidth();
      const h = (w * p.r.width) / FRAME_ASPECT / p.r.height;
      f = { x: start.current.x - w / 2, y: start.current.y - h / 2, w, h };
    }
    start.current = null;
    setDrag(null);
    setSent(f);
    onFrame(f, p.r.width / p.r.height);
  };

  return (
    <div
      ref={box}
      className={`aim__stage ${disabled ? 'aim__stage--off' : ''}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => { start.current = null; setDrag(null); }}
    >
      <img src={`${image}${image.includes('?') ? '&' : '?'}a=${failed}`} alt="" draggable={false} onError={() => setTimeout(() => setFailed((n) => n + 1), 3000)} />
      {live && (
        <div className="aim__live" style={pct(live.frame)} aria-label="Live picture">
          <img src={live.src} alt="" draggable={false} />
        </div>
      )}
      {sent && <div className="aim__frame aim__frame--sent" style={pct(sent)} />}
      {drag && <div className="aim__frame" style={pct(drag)} />}
    </div>
  );
}

interface FovProps {
  config: BridgeConfig;
  connected: boolean;
  busy: boolean;
  progress?: JobProgress;
  onCalibrate: () => void;
  onSetConfig: (cfg: Partial<BridgeConfig>) => void;
}

/** The field of view per zoom: datasheet ends by hand, or measured by the bridge. Rarely needed, so folded away. */
function FovSettings({ config, connected, busy, progress, onCalibrate, onSetConfig }: FovProps) {
  const num = (v: string) => {
    const n = Number(v.replace(',', '.'));
    return v.trim() && n > 0 ? n : undefined;
  };
  const table = config.fovTable ?? [];
  const running = !!progress && JOB_RUNNING.has(progress.step);
  return (
    <details className="aim__fov" style={{ marginTop: 12 }}>
      <summary className="hint">Field of view per zoom{table.length ? ` · ${table.length} points measured` : ''}</summary>
      <div className="row" style={{ marginTop: 8 }}>
        <div className="field field--sm">
          <span className="aim__label">Wide °</span>
          <input
            key={`w${config.hfovWideDeg}`}
            defaultValue={config.hfovWideDeg ?? ''}
            inputMode="decimal"
            onBlur={(e) => onSetConfig({ hfovWideDeg: num(e.target.value) })}
            aria-label="Horizontal field of view at the wide end, degrees (datasheet)"
          />
        </div>
        <div className="field field--sm">
          <span className="aim__label">Tele °</span>
          <input
            key={`t${config.hfovTeleDeg}`}
            defaultValue={config.hfovTeleDeg ?? ''}
            inputMode="decimal"
            onBlur={(e) => onSetConfig({ hfovTeleDeg: num(e.target.value) })}
            aria-label="Horizontal field of view at the tele end, degrees (datasheet)"
          />
        </div>
        <div className="field field--sm">
          <span className="aim__label">Sensor mm</span>
          <input
            key={`s${config.sensorWidthMm}`}
            defaultValue={config.sensorWidthMm ?? ''}
            inputMode="decimal"
            onBlur={(e) => onSetConfig({ sensorWidthMm: num(e.target.value) })}
            aria-label="Sensor width in mm (with the zoom curve's focal lengths it gives the field of view)"
          />
        </div>
        <button
          className="btn btn--sm"
          disabled={!connected || busy}
          onClick={onCalibrate}
          title="At five zoom positions the head pans a little and the bridge measures how far the picture moved. Needs a textured view near tilt 0."
        >
          {running ? 'Measuring…' : 'Measure'}
        </button>
        {table.length > 0 && <button className="btn btn--sm" disabled={busy} onClick={() => onSetConfig({ fovTable: [] })}>Clear measured</button>}
      </div>
      {table.length > 0 && (
        <p className="hint" style={{ marginTop: 4 }}>{table.map((p) => `${Math.round(p.position * 100)} % → ${p.hfovDeg}°`).join(' · ')}</p>
      )}
      {progress && Date.now() - progress.at < 120000 && (
        <p className="hint" role="status" style={{ marginTop: 4 }}>
          {progress.step === 'point'
            ? `zoom ${Math.round((progress.zoom ?? 0) * 100)} %: ${progress.hfovDeg ? `${progress.hfovDeg}°` : progress.reason ?? 'no value'} (${progress.index}/${progress.total})`
            : `${progress.step}${progress.message ? `: ${progress.message}` : ''}`}
        </p>
      )}
      <p className="hint" style={{ marginTop: 4 }}>
        The datasheet's horizontal angles at wide and tele are enough to start; measuring makes the zoom between them exact.
      </p>
    </details>
  );
}
