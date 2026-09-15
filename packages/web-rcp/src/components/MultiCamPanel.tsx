import React from 'react';
import { SonyRcpPanel } from './SonyRcpPanel.tsx';
import { PtzPanel } from './PtzPanel.tsx';
import { capabilitiesForMode, isPtzMode } from '../capabilities.ts';
import type { CameraStatesByNumber, TallyState } from '../types.ts';
import type { CameraSlot } from '../hooks/useBridge.ts';

const MODE_LABEL: Record<string, string> = {
  tcp: 'Sony CCU', serial: 'Sony RS-422', 'sony-usb': 'Sony USB', 'sony-mnc': 'Sony WiFi',
  'lumix-http': 'Lumix', 'canon-ccapi': 'Canon', blackmagic: 'Blackmagic', zcam: 'Z CAM',
  'panasonic-ptz': 'Pana PTZ', visca: 'VISCA', jvc: 'JVC', birddog: 'BirdDog',
};

interface Props {
  cameras: Record<number, CameraSlot>;
  cameraStates: CameraStatesByNumber;
  tally: TallyState;
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
          const caps = capabilitiesForMode(mode);
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
                <span className="multicam__card-mode">{MODE_LABEL[mode] ?? mode}</span>
                <div className="multicam__card-actions">
                  <button className="btn btn--sm" onClick={() => p.onEdit(num)} title="Konfigurieren">⚙</button>
                  {connected ? (
                    <button className="btn btn--sm btn--danger" onClick={() => p.onDisconnect(num)}>Trennen</button>
                  ) : (
                    <button className="btn btn--sm btn--primary" onClick={() => p.onConnect(num)}>Verbinden</button>
                  )}
                  <button className="camera-list__remove" title="Entfernen" onClick={() => p.onRemove(num)}>✕</button>
                </div>
              </div>

              <div className="multicam__card-body">
                {ptz ? (
                  <PtzPanel cameraId={num} disabled={!connected} onCommand={(cmd, params) => p.onCommand(num, cmd, params)} />
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
