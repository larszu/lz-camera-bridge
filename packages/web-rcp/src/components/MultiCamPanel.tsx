import React from 'react';
import { SonyRcpPanel } from './SonyRcpPanel.tsx';
import { PtzPanel } from './PtzPanel.tsx';
import { capabilitiesForMode, isPtzMode } from '../capabilities.ts';
import type { CameraStatesByNumber, CameraTally, TallyState } from '../types.ts';
import type { CameraSlot } from '../hooks/useBridge.ts';
import { MODE_LABEL, ptzExtrasFor } from '../App.tsx';
import { Icon } from './Icon.tsx';

interface Props {
  cameras: Record<number, CameraSlot>;
  cameraStates: CameraStatesByNumber;
  tally: TallyState;
  cameraTally: CameraTally;
  onAddCamera: () => void;
  onConnect: (num: number) => void;
  onDisconnect: (num: number) => void;
  onRemove: (num: number) => void;
  onCommand: (num: number, cmd: string, params: Record<string, unknown>) => void;
  onSetTally: (num: number, tally: Partial<TallyState>) => void;
  onEdit: (num: number) => void;
}

/**
 * Multi-camera control wall: every configured camera rendered as its own live
 * control panel (RCP for paint cameras, PTZ for PTZ heads), operated in place.
 * Backed by the bridge's simultaneous camera slots, so all panels are live at
 * once — this is the functional replacement for the old faked dashboard.
 */
export function MultiCamPanel(p: Props) {
  const nums = Object.keys(p.cameras).map(Number).sort((a, b) => a - b);

  return (
    <div className="multicam">
      <div className="multicam__bar">
        {/* EIN Satz, nicht drei Stuecke. Hier stand
            `{n} Kamera{n === 1 ? '' : 's'}` — ein deutsches Wort mit einer
            ENGLISCHEN Pluralregel, zusammengesetzt aus drei Teilen. Die
            Wortstellung und die Mehrzahl gehoeren zur Sprache: im Deutschen
            hiesse es „Kameras", im Polnischen haengt die Form von der Zahl
            ab, und keine dieser Regeln laesst sich aus Stuecken bauen. Der
            ganze Satz steht deshalb hier als ganzer Satz. */}
        <span className="multicam__title">
          Multiview · {nums.length === 1 ? '1 camera' : `${nums.length} cameras`}
        </span>
        <button className="btn btn--sm btn--primary" onClick={p.onAddCamera}>+ Camera</button>
      </div>

      {nums.length === 0 && (
        <div className="app__empty">No cameras yet. "+ Camera" adds one.</div>
      )}

      <div className="multicam__grid">
        {nums.map((num) => {
          const cam = p.cameras[num];
          const mode = cam.config.connectionMode ?? 'tcp';
          const connected = cam.connected;
          const state = p.cameraStates[num] ?? {};
          const caps = capabilitiesForMode(mode, cam.config.cgiFamily);
          const ptz = isPtzMode(mode);

          return (
            <div key={num} className={`multicam__card ${connected ? 'multicam__card--on' : ''} ${ptz ? 'multicam__card--ptz' : ''}`}>
              <div className="multicam__card-head">
                <span className={`status-dot status-dot--${connected ? 'ok' : 'err'}`} />
                <span className="multicam__card-num">{num}</span>
                {/* Die Beschriftung aus dem Plan (B-41.1): am Pult steht dann
                    "CAM 3 -- Buehne links" statt einer nackten Nummer. Ein
                    blosser Vorschlag (Nummer im Namen) wird gekennzeichnet --
                    sonst sieht er aus wie ein Befund. */}
                {cam.plan && (
                  <span
                    className={`multicam__card-plan ${cam.planMatchedBy === 'number' ? 'multicam__card-plan--weak' : ''}`}
                    title={cam.planMatchedBy === 'number'
                      ? 'Proposed from the number in the name, not measured'
                      : cam.planMatchedBy === 'model' ? 'Model measured' : 'Assigned by hand'}
                  >
                    {cam.plan.label}
                    {cam.planMatchedBy === 'number' ? ' ?' : ''}
                  </span>
                )}
                {!cam.plan && cam.config.label && <span className="multicam__card-plan">{cam.config.label}</span>}
                <span className="multicam__card-mode">{MODE_LABEL[mode] ?? mode}</span>
                {p.cameraTally[num] && p.cameraTally[num] !== 'off' && (
                  <span className={`tile__tally tile__tally--${p.cameraTally[num]}`}>{p.cameraTally[num] === 'program' ? 'PGM' : 'PVW'}</span>
                )}
                <div className="multicam__card-actions">
                  <button className="btn btn--sm" onClick={() => p.onEdit(num)} title="Set up" aria-label="Set up"><Icon name="settings" size={16} /></button>
                  {connected ? (
                    <button className="btn btn--sm btn--danger" onClick={() => p.onDisconnect(num)}>Disconnect</button>
                  ) : (
                    <button className="btn btn--sm btn--primary" onClick={() => p.onConnect(num)}>Connect</button>
                  )}
                  <button className="camera-list__remove" title="Remove" aria-label="Remove" onClick={() => p.onRemove(num)}><Icon name="x" size={14} /></button>
                </div>
              </div>

              <div className="multicam__card-body">
                {ptz ? (
                  <PtzPanel
                    cameraId={num}
                    label={cam.plan?.label ?? cam.config.label}
                    disabled={!connected}
                    onCommand={(cmd, params) => p.onCommand(num, cmd, params)}
                    extras={ptzExtrasFor(cam.config)}
                    power={state.cameraPower}
                    tally={p.cameraTally[num]}
                  />
                ) : (
                  <SonyRcpPanel
                    state={state}
                    tally={p.tally}
                    cameraId={num}
                    disabled={!connected}
                    capabilities={caps}
                    onCommand={(cmd, params) => p.onCommand(num, cmd, params)}
                    onSetTally={(t) => p.onSetTally(num, t)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
