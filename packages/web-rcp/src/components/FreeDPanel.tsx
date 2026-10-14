import React, { useEffect, useState } from 'react';
import type { CameraSlot } from '../hooks/useBridge.ts';
import type { FreeDCameraConfig, FreeDInfo, FreeDSiteConfig, FreeDTarget } from '../types.ts';

/**
 * FreeD tracking out of the bridge: where the packets go (targets), how
 * often (rate), and one switch per camera that reports its pose. Details per
 * camera (FreeD id, mounting position, inversion) sit folded under the
 * switch — most rooms never open them.
 *
 * The bridge does the work (`transport/FreeDOutput.ts`); this panel only
 * edits its settings and shows what it reports back.
 */

interface Props {
  freed: FreeDInfo;
  cameras: Record<number, CameraSlot>;
  onSetSite: (cfg: FreeDSiteConfig | null) => void;
  onSetCamera: (num: number, cfg: FreeDCameraConfig | null) => void;
}

/** Unreal's Live Link FreeD source listens here unless told otherwise. */
const SUGGESTED_PORT = 40000;
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function NumberField({ label, value, onCommit, step = 1, width = 90 }: {
  label: string; value: number | undefined; onCommit: (v: number | undefined) => void; step?: number; width?: number;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    const t = text.trim();
    const n = t === '' ? undefined : Number(t);
    if (n !== undefined && !Number.isFinite(n)) { setText(value === undefined ? '' : String(value)); return; }
    if (n !== value) onCommit(n);
  };
  return (
    <div className="field" style={{ width }}>
      <label>{label}</label>
      <input
        inputMode="decimal" step={step} value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function FreeDPanel({ freed, cameras, onSetSite, onSetCamera }: Props) {
  const site: FreeDSiteConfig = freed.config ?? { targets: [], rateHz: 50 };
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(SUGGESTED_PORT));

  const update = (patch: Partial<FreeDSiteConfig>) => onSetSite({ ...site, ...patch });
  const addTarget = () => {
    const p = Number(port);
    const h = host.trim();
    if (!h || !Number.isInteger(p) || p < 1 || p > 65535) return;
    update({ targets: [...site.targets, { host: h, port: p }] });
    setHost('');
  };
  const removeTarget = (t: FreeDTarget) => update({ targets: site.targets.filter((x) => x !== t) });

  const nums = Object.keys(cameras).map(Number).sort((a, b) => a - b);
  const statusOf = (n: number) => freed.status.cameras.find((c) => c.cameraNumber === n);

  return (
    <div className="panel">
      <h2 className="panel__title">FreeD tracking</h2>
      <p className="hint">
        Pan, tilt, zoom and focus of every switched-on camera as FreeD D1 over UDP — for virtual studio and AR
        engines such as Unreal Live Link. Untested against a real receiver so far.
      </p>

      <div className="site-list" style={{ marginTop: 8 }}>
        {site.targets.map((t) => (
          <div key={`${t.host}:${t.port}`} className="site-item">
            <span className="site-item__num">UDP</span>
            <span className="site-item__name">{t.host}:{t.port}</span>
            <button className="btn btn--sm" onClick={() => removeTarget(t)}>Remove</button>
          </div>
        ))}
        {site.targets.length === 0 && <div className="empty">No target — nothing is sent.</div>}
      </div>
      <div className="connection-row" style={{ marginTop: 8 }}>
        <div className="field">
          <label>Receiver address</label>
          <input value={host} placeholder="192.168.0.20" onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTarget(); }} />
        </div>
        <div className="field" style={{ width: 100 }}>
          <label>Port</label>
          <input inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTarget(); }} />
        </div>
        <button className="btn btn--sm" onClick={addTarget} disabled={!host.trim()}>+ Target</button>
      </div>
      <div className="connection-row" style={{ marginTop: 8 }}>
        <div className="field" style={{ width: 140 }}>
          <label>Rate</label>
          <select className="select-group__select" value={String(site.rateHz)} onChange={(e) => update({ rateHz: Number(e.target.value) })}>
            {[...new Set([...RATES, site.rateHz])].sort((a, b) => a - b).map((r) => <option key={r} value={String(r)}>{r} Hz</option>)}
          </select>
        </div>
        <NumberField label="Pose read every (ms)" value={site.pollMs} width={150}
          onCommit={(v) => update({ pollMs: v })} />
      </div>
      <p className="hint">
        Port {SUGGESTED_PORT} is where Unreal's FreeD source listens by default. Between two pose reads the packets
        are interpolated; a camera that stops answering goes silent instead of freezing.
      </p>

      <div className="site-list" style={{ marginTop: 12 }}>
        {nums.map((n) => {
          const c = cameras[n];
          const cfg = c.config.freed;
          const on = Boolean(cfg?.enabled);
          const set = (patch: Partial<FreeDCameraConfig>) => onSetCamera(n, { enabled: on, ...cfg, ...patch });
          const st = statusOf(n);
          const name = c.plan?.label ?? c.config.label ?? `Camera ${n}`;
          if (!c.freedCapable) {
            return (
              <div key={n} className="site-item">
                <span className="site-item__num">CAM {n}</span>
                <span><span className="site-item__name">{name}</span><span className="site-item__meta"> · reports no pose on this path</span></span>
                <span />
              </div>
            );
          }
          const pos = cfg?.positionMm ?? { x: 0, y: 0, z: 0 };
          return (
            <div key={n} className="site-item" style={{ gridTemplateColumns: '40px 1fr auto', alignItems: 'start' }}>
              <span className="site-item__num">CAM {n}</span>
              <span>
                <span className="site-item__name">{name}</span>
                <span className="site-item__meta">
                  {' · '}
                  {!on ? 'off'
                    : !c.connected ? 'waiting for the camera'
                    : st ? `${st.sent} packets · id ${st.cameraId}${st.readAgeMs !== null ? ` · read ${st.readAgeMs} ms ago` : ''}`
                      + (st.unread.length ? ` · ${st.unread.join(' + ')} not reported (sent as 0)` : '')
                      + (st.lastError ? ` · ${st.lastError}` : '')
                    : site.targets.length === 0 ? 'no target' : 'starting'}
                </span>
                {on && (
                  <details style={{ marginTop: 6 }}>
                    <summary className="hint" style={{ cursor: 'pointer' }}>Details</summary>
                    <div className="connection-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                      <NumberField label="FreeD id" value={cfg?.cameraId} onCommit={(v) => set({ cameraId: v })} width={80} />
                      <NumberField label="X (mm)" value={pos.x} onCommit={(v) => set({ positionMm: { ...pos, x: v ?? 0 } })} />
                      <NumberField label="Y (mm)" value={pos.y} onCommit={(v) => set({ positionMm: { ...pos, y: v ?? 0 } })} />
                      <NumberField label="Z (mm)" value={pos.z} onCommit={(v) => set({ positionMm: { ...pos, z: v ?? 0 } })} />
                      {c.config.connectionMode === 'robotic-head' && (
                        <NumberField label="Column mm/count" value={cfg?.columnMmPerCount} width={130}
                          onCommit={(v) => set({ columnMmPerCount: v })} />
                      )}
                      <NumberField label="Pan offset (°)" value={cfg?.offsetDeg?.pan} width={110}
                        onCommit={(v) => set({ offsetDeg: { ...cfg?.offsetDeg, pan: v } })} />
                      <NumberField label="Tilt offset (°)" value={cfg?.offsetDeg?.tilt} width={110}
                        onCommit={(v) => set({ offsetDeg: { ...cfg?.offsetDeg, tilt: v } })} />
                    </div>
                    <div className="row" style={{ marginTop: 6, gap: 12, flexWrap: 'wrap' }}>
                      {(['pan', 'tilt', 'zoom', 'focus'] as const).map((axis) => (
                        <Check key={axis} label={`Invert ${axis}`} checked={Boolean(cfg?.invert?.[axis])}
                          onChange={(v) => set({ invert: { ...cfg?.invert, [axis]: v } })} />
                      ))}
                    </div>
                  </details>
                )}
              </span>
              <span className="row">
                {on && c.connected && <span className={`status-dot status-dot--${st && st.sent > 0 && !st.lastError ? 'ok' : 'err'}`} />}
                <button
                  className={`btn btn--sm ${on ? 'btn--primary' : ''}`}
                  aria-pressed={on}
                  onClick={() => onSetCamera(n, { ...cfg, enabled: !on })}
                >
                  {on ? 'FreeD on' : 'FreeD off'}
                </button>
              </span>
            </div>
          );
        })}
        {nums.length === 0 && <div className="empty">No cameras yet.</div>}
      </div>
    </div>
  );
}
