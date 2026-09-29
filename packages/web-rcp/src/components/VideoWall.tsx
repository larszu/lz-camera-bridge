import React, { useEffect, useMemo, useState } from 'react';
import type { CameraSlot } from '../hooks/useBridge.ts';
import { videoUrl } from '../hooks/useBridge.ts';
import type { CameraTally, SwitcherSlot } from '../types.ts';
import { ScopeOverlay, ScopePanel } from './ScopePanel.tsx';

/**
 * The live pictures. Every tile is an <img> on the bridge's MJPEG endpoint —
 * no player, no WebRTC, one ffmpeg per camera in the bridge shared by every
 * window that shows it. Tally from the switcher on the top edge; a click
 * previews the camera's input, a double-click takes it.
 *
 * "Scopes" on a tile opens waveform + vectorscope under it (ScopePanel.tsx);
 * those measure raw frames from the bridge's `/scope/<n>`, not this JPEG.
 */

interface Props {
  cameras: Record<number, CameraSlot>;
  cameraTally: CameraTally;
  switcher: SwitcherSlot | null;
  onSwitcherCommand: (cmd: string, params?: Record<string, unknown>) => void;
  onEdit?: (num: number) => void;
  /** Tiles only — for the second screen. */
  bare?: boolean;
}

function columnsFor(count: number, wish: number | null): number {
  if (wish) return wish;
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

const COLS_KEY = 'lz-bridge.wall.cols';

export function VideoWall({ cameras, cameraTally, switcher, onSwitcherCommand, onEdit, bare }: Props) {
  const nums = useMemo(() => Object.keys(cameras).map(Number).sort((a, b) => a - b), [cameras]);
  const [wish, setWish] = useState<number | null>(() => {
    try { const v = Number(localStorage.getItem(COLS_KEY)); return v > 0 ? v : null; } catch { return null; }
  });
  useEffect(() => {
    try { if (wish) localStorage.setItem(COLS_KEY, String(wish)); else localStorage.removeItem(COLS_KEY); } catch { /* per-viewer convenience only */ }
  }, [wish]);

  const canSwitch = !!switcher?.connected;
  const cols = columnsFor(nums.length, wish);

  const tiles = nums.map((num) => (
    <Tile
      key={num}
      cam={cameras[num]}
      tally={cameraTally[num] ?? 'off'}
      canSwitch={canSwitch}
      onPreview={() => { const i = cameras[num].config.switcherInput ?? 0; if (i > 0) onSwitcherCommand('preview', { source: i }); }}
      onTake={() => { const i = cameras[num].config.switcherInput ?? 0; if (i > 0) onSwitcherCommand('take', { source: i }); }}
      onEdit={onEdit ? () => onEdit(num) : undefined}
    />
  ));

  if (bare) {
    return <div className="wall wall--bare" style={{ '--wall-cols': cols } as React.CSSProperties}>{tiles}</div>;
  }

  return (
    <div className="stack">
      <div className="headline">
        <span className="headline__kicker">Video</span>
        <span className="headline__title">{nums.length === 1 ? '1 camera' : `${nums.length} cameras`}</span>
        <span className="headline__meta">
          <label className="row">
            <span className="hint">Columns</span>
            <select className="select-group__select" value={wish ?? 0} onChange={(e) => setWish(Number(e.target.value) || null)}>
              <option value={0}>auto</option>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button
            className="btn btn--sm"
            onClick={() => window.open(`${location.pathname}?view=video&bare=1`, 'lz-bridge-video', 'width=1280,height=760')}
            title="The tiles alone, for a second screen"
          >
            Own window
          </button>
        </span>
      </div>
      {nums.length === 0 && <div className="empty">No cameras yet. Add one under Cameras and give it a stream address.</div>}
      <div className="wall" style={{ '--wall-cols': cols } as React.CSSProperties}>{tiles}</div>
      <p className="hint">
        Click a tile to preview its switcher input, double-click to take it. The picture comes from the camera's stream
        address (RTSP), scaled down by the bridge; the on-air signal is untouched. Scopes measure the decoded stream,
        not the tile picture; each open scope holds one more stream session on the camera.
      </p>
    </div>
  );
}

interface TileProps {
  cam: CameraSlot;
  tally: 'program' | 'preview' | 'off';
  canSwitch: boolean;
  onPreview: () => void;
  onTake: () => void;
  onEdit?: () => void;
}

function Tile({ cam, tally, canSwitch, onPreview, onTake, onEdit }: TileProps) {
  const num = cam.cameraNumber;
  // Without the leading "CAM n" a plan label would repeat next to the number.
  const name = (cam.plan?.label ?? cam.config.label ?? '').replace(/^cam\s*\d+\s*[—–-]?\s*/i, '');
  const hasStream = Boolean(cam.config.streamUrl);
  // A broken <img> stays broken; a new URL (cache-buster) reconnects it.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => { setFailed(false); setAttempt((a) => a + 1); }, 3000);
    return () => clearTimeout(t);
  }, [failed]);

  const switchable = canSwitch && (cam.config.switcherInput ?? 0) > 0;
  const [scopes, setScopes] = useState<'off' | 'inline' | 'full'>('off');

  return (
    <div className="wall__cell">
      <div
        className={`tile tile--${tally}`}
        onClick={switchable ? onPreview : undefined}
        onDoubleClick={switchable ? onTake : undefined}
        title={switchable ? `Input ${cam.config.switcherInput}: click = preview, double-click = take` : undefined}
        style={{ cursor: switchable ? 'pointer' : 'default' }}
      >
        {hasStream ? (
          <img
            src={`${videoUrl(num)}?a=${attempt}`}
            alt=""
            onError={() => setFailed(true)}
            draggable={false}
          />
        ) : (
          <div className="tile__empty">
            <span>
              No stream address for camera {num}.
              {onEdit && <><br /><button className="btn btn--sm" style={{ marginTop: 8 }} onClick={(e) => { e.stopPropagation(); onEdit(); }}>Set it up</button></>}
            </span>
          </div>
        )}
        {failed && hasStream && <span className="tile__off">reconnecting…</span>}
        <div className="tile__bar">
          <span className="tile__num">CAM {num}</span>
          <span className="tile__name">{name}</span>
          {tally !== 'off' && <span className={`tile__tally tile__tally--${tally}`}>{tally === 'program' ? 'PGM' : 'PVW'}</span>}
          {hasStream && (
            <button
              className="tile__scopes"
              aria-pressed={scopes !== 'off'}
              onClick={(e) => { e.stopPropagation(); setScopes(scopes === 'off' ? 'inline' : 'off'); }}
              onDoubleClick={(e) => e.stopPropagation()}
              title="Waveform and vectorscope of this stream"
            >
              Scopes
            </button>
          )}
        </div>
      </div>
      {hasStream && scopes === 'inline' && (
        <ScopePanel
          cameraNumber={num}
          title={`CAM ${num}${name ? ` · ${name}` : ''}`}
          scopes={['wf-luma', 'vector']}
          onClose={() => setScopes('off')}
          onExpand={() => setScopes('full')}
        />
      )}
      {hasStream && scopes === 'full' && (
        <ScopeOverlay cameraNumber={num} title={`CAM ${num}${name ? ` · ${name}` : ''}`} onClose={() => setScopes('inline')} />
      )}
    </div>
  );
}
