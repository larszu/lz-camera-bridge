import React, { useEffect, useState } from 'react';
import type { CameraSlot } from '../hooks/useBridge.ts';
import { BRIDGE_HTTP } from '../hooks/useBridge.ts';
import type { SiteInfo, SwitcherSlot } from '../types.ts';

/**
 * The room as one file. Export downloads what the bridge holds; import
 * replaces it — our own `lz-site` format or the settings export of the old
 * av-control-center. When the bridge persists (desktop app, `index.ts`), the
 * same file is what survives a restart.
 */

interface Props {
  site: SiteInfo;
  cameras: Record<number, CameraSlot>;
  switchers: Record<number, SwitcherSlot>;
  bridgeConnected: boolean;
  onSetName: (name: string) => void;
  onImport: (text: string) => void;
  onEditCamera: (num: number) => void;
  onAddSwitcher: () => void;
  onEditSwitcher: () => void;
}

const MODE_LABEL: Record<string, string> = {
  tcp: 'Sony CCU', serial: 'Sony RS-422', 'sony-usb': 'Sony USB', 'sony-mnc': 'Sony WiFi',
  'lumix-http': 'Lumix', 'canon-ccapi': 'Canon', blackmagic: 'Blackmagic', zcam: 'Z CAM',
  'panasonic-ptz': 'Pana PTZ', visca: 'VISCA', 'visca-serial': 'VISCA RS-232', jvc: 'JVC', birddog: 'BirdDog',
  'http-cgi': 'HTTP-CGI', 'dji-osmo': 'DJI Osmo', 'dji-ronin': 'DJI Ronin', 'b4-lens': 'B4 lens', demo: 'Demo',
};

export function SitePanel({ site, cameras, switchers, bridgeConnected, onSetName, onImport, onEditCamera, onAddSwitcher, onEditSwitcher }: Props) {
  const [name, setName] = useState(site.name);
  useEffect(() => setName(site.name), [site.name]);
  const [clearArmed, setClearArmed] = useState(false);
  useEffect(() => {
    if (!clearArmed) return;
    const t = setTimeout(() => setClearArmed(false), 4000);
    return () => clearTimeout(t);
  }, [clearArmed]);

  const camNums = Object.keys(cameras).map(Number).sort((a, b) => a - b);
  const swNums = Object.keys(switchers).map(Number).sort((a, b) => a - b);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onImport(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  return (
    <div className="stack">
      <div className="headline">
        <span className="headline__kicker">Site</span>
        <span className="headline__title">{site.name || 'Unnamed room'}</span>
        <span className="headline__meta">
          <span className={`chip ${bridgeConnected ? 'chip--on' : ''}`}>{bridgeConnected ? 'bridge' : 'no bridge'}</span>
        </span>
      </div>

      <div className="view__grid">
        <div className="stack">
          <div className="panel">
            <h2 className="panel__title">Devices</h2>
            <div className="site-list">
              {camNums.map((n) => {
                const c = cameras[n];
                const mode = c.config.connectionMode ?? 'tcp';
                const addr = c.config.camHost ?? c.config.tcpHost ?? c.config.bmHost ?? c.config.canonHost ?? c.config.lumixHost ?? c.config.mncHost ?? c.config.serialPath ?? c.config.viscaSerialPath ?? '';
                return (
                  <div key={`c${n}`} className="site-item">
                    <span className="site-item__num">CAM {n}</span>
                    <span>
                      <span className="site-item__name">{c.plan?.label ?? c.config.label ?? MODE_LABEL[mode] ?? mode}</span>
                      <span className="site-item__meta"> · {MODE_LABEL[mode] ?? mode}{addr ? ` · ${addr}` : ''}
                        {c.config.switcherInput ? ` · input ${c.config.switcherInput}` : ''}
                        {c.config.streamUrl ? ' · stream' : ''}
                      </span>
                    </span>
                    <span className="row">
                      <span className={`status-dot status-dot--${c.connected ? 'ok' : 'err'}`} />
                      <button className="btn btn--sm" onClick={() => onEditCamera(n)}>Edit</button>
                    </span>
                  </div>
                );
              })}
              {swNums.map((n) => {
                const s = switchers[n];
                return (
                  <div key={`s${n}`} className="site-item">
                    <span className="site-item__num">SW {n}</span>
                    <span>
                      <span className="site-item__name">{s.config.label || 'VIS-CATC'}</span>
                      <span className="site-item__meta"> · {s.config.host ?? 'no address'} · {s.config.path === 'serial' ? 'RS-232' : 'HTTP'}</span>
                    </span>
                    <span className="row">
                      <span className={`status-dot status-dot--${s.connected ? 'ok' : 'err'}`} />
                      <button className="btn btn--sm" onClick={onEditSwitcher}>Edit</button>
                    </span>
                  </div>
                );
              })}
              {camNums.length === 0 && swNums.length === 0 && <div className="empty">Nothing here yet. Add a camera, a switcher, or import a site file.</div>}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btn--sm" onClick={() => onEditCamera(0)}>+ Camera</button>
              {swNums.length === 0 && <button className="btn btn--sm" onClick={onAddSwitcher}>+ Switcher</button>}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h2 className="panel__title">Name</h2>
            <div className="connection-row">
              <div className="field">
                <input
                  value={name}
                  placeholder="Conference room"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => { if (name !== site.name) onSetName(name); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                />
              </div>
            </div>
          </div>

          <div className="panel">
            <h2 className="panel__title">File</h2>
            <div className="row">
              <a className="btn btn--sm" href={`${BRIDGE_HTTP}/site.json`} download>Export</a>
              <span className="btn btn--sm file-btn">
                Import…
                <input type="file" accept=".json,application/json" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
              </span>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>
              Import replaces every camera and switcher with the file's. Reads the bridge's own site file and the
              settings export of av-control-center. Passwords are part of the file.
            </p>
            {site.path ? (
              <p className="hint">Kept on the bridge computer at <code>{site.path}</code>; restored on every start.</p>
            ) : (
              <p className="hint">This bridge does not persist — the room lives until the bridge stops. Export it to keep it.</p>
            )}
          </div>

          <div className="panel">
            <h2 className="panel__title">Reset</h2>
            <button
              className={`btn btn--sm ${clearArmed ? 'btn--danger' : ''}`}
              onClick={() => {
                if (clearArmed) { onImport(JSON.stringify({ kind: 'lz-site', formatVersion: 1, name: '', cameras: [], switchers: [] })); setClearArmed(false); }
                else setClearArmed(true);
              }}
            >
              {clearArmed ? 'Remove everything — click again' : 'Remove all devices'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
