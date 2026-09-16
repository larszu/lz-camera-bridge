import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useBridge } from './hooks/useBridge.ts';
import { ConnectionPanel } from './components/ConnectionPanel.tsx';
import { SonyRcpPanel } from './components/SonyRcpPanel.tsx';
import { PtzPanel } from './components/PtzPanel.tsx';
import { MultiCamPanel } from './components/MultiCamPanel.tsx';
import { CameraPlanPanel } from './components/CameraPlanPanel.tsx';
import { WiznetPanel } from './components/WiznetPanel.tsx';
import { FirstStartWizard, isWizardDone } from './components/FirstStartWizard.tsx';
import { capabilitiesForMode, isPtzMode } from './capabilities.ts';
import type { BridgeConfig, WiznetDevice } from './types.ts';
import type { TallyState } from './components/TallyBar.tsx';
import './styles/sony-rcp.css';
import './styles/wizard.css';
import './styles/ptz-panel.css';

type PanelView = 'rcp' | 'ptz';
type ViewMode = 'single' | 'multi';

const MODE_LABEL: Record<string, string> = {
  tcp: 'Sony CCU', serial: 'Sony RS-422', 'sony-usb': 'Sony USB', 'sony-mnc': 'Sony WiFi',
  'lumix-http': 'Lumix', 'canon-ccapi': 'Canon', blackmagic: 'Blackmagic', zcam: 'Z CAM',
  'panasonic-ptz': 'Pana PTZ', visca: 'VISCA', jvc: 'JVC', birddog: 'BirdDog',
};

const newCameraConfig = (num: number): BridgeConfig => ({
  connectionMode: 'tcp', tcpHost: '192.168.1.10', tcpPort: 7700, ccuId: num,
});

export default function App() {
  const [panelView, setPanelView] = useState<PanelView>('rcp');
  const [viewMode, setViewMode] = useState<ViewMode>('single');
  const [showWizard, setShowWizard] = useState(!isWizardDone());
  const [selected, setSelected] = useState<number | null>(null);

  const bridge = useBridge();
  const {
    status, cameras, cameraStates, cameraOrigins, cameraConfirmations, ports, wiznetDevices, sonyUsbDevices, sonyMncDevices,
    hidDevices, controlSurfaceActive, tally, errorMsg, planMatch,
    setCameraConfig, connectCamera, disconnectCamera, removeCamera, sendCommand,
    listPorts, discoverWiznet, configureWiznet, discoverSonyUsb, discoverSonyMnc,
    listHidDevices, enableControlSurface, disableControlSurface, setTally,
    matchCameraPlan, applyCameraPlan,
  } = bridge;

  const camNumbers = useMemo(
    () => Object.keys(cameras).map(Number).sort((a, b) => a - b),
    [cameras],
  );

  // Keep a valid selection as cameras come and go.
  useEffect(() => {
    if (selected === null || !cameras[selected]) {
      setSelected(camNumbers[0] ?? null);
    }
  }, [camNumbers, cameras, selected]);

  const addCamera = useCallback(() => {
    const num = (camNumbers.length ? Math.max(...camNumbers) : 0) + 1;
    setCameraConfig(num, newCameraConfig(num));
    setSelected(num);
  }, [camNumbers, setCameraConfig]);

  const handleWizardComplete = useCallback(
    (wizardConfig: Partial<BridgeConfig>) => {
      const num = (camNumbers.length ? Math.max(...camNumbers) : 0) + 1;
      setCameraConfig(num, { ...newCameraConfig(num), ...wizardConfig });
      setSelected(num);
      setShowWizard(false);
    },
    [camNumbers, setCameraConfig],
  );

  const handleSelectWiznet = useCallback(
    (device: WiznetDevice) => {
      if (selected !== null) setCameraConfig(selected, { connectionMode: 'tcp', tcpHost: device.ip, tcpPort: device.port });
    },
    [selected, setCameraConfig],
  );

  const handleSetTally = useCallback((t: Partial<TallyState>) => setTally(t), [setTally]);

  const cam = selected !== null ? cameras[selected] : undefined;
  const config = cam?.config ?? newCameraConfig(selected ?? 1);
  const connected = cam?.connected ?? false;
  const shownState = selected !== null ? cameraStates[selected] ?? {} : {};
  // BEDARF 46 — die Herkunft der angezeigten Werte, und ob dieser Weg
  // ueberhaupt je etwas zurueckliest. Beides kommt von der Bruecke.
  const shownOrigins = selected !== null ? cameraOrigins[selected] ?? {} : {};
  // BEDARF 102 — Zeitstempel je Feld und die fertigen Grenzen je Kamera.
  const shownConfirmations = selected !== null ? cameraConfirmations[selected] ?? {} : {};
  const neverReadsBack = cam?.neverReadsBack ?? false;
  const capabilities = capabilitiesForMode(config.connectionMode);

  useEffect(() => {
    setPanelView(isPtzMode(config.connectionMode) ? 'ptz' : 'rcp');
  }, [config.connectionMode, selected]);

  const onCommand = useCallback(
    (cmd: string, params: Record<string, unknown>) => {
      if (selected !== null) sendCommand(selected, cmd, params);
    },
    [selected, sendCommand],
  );

  return (
    <div className="app">
      {showWizard && <FirstStartWizard onComplete={handleWizardComplete} />}
      <header className="app__header">
        <span className="app__title">LZ Camera Bridge</span>
        <span className={`app__ws status-dot status-dot--${status === 'connected' ? 'ok' : 'err'}`} title={`Bridge: ${status}`} />
        <div className="app__viewtabs">
          <button className={`rcp-btn rcp-btn--sm ${viewMode === 'single' ? 'rcp-btn--primary' : 'rcp-btn--secondary'}`} onClick={() => setViewMode('single')}>
            Single view
          </button>
          <button className={`rcp-btn rcp-btn--sm ${viewMode === 'multi' ? 'rcp-btn--primary' : 'rcp-btn--secondary'}`} onClick={() => setViewMode('multi')}>
            Multiview
          </button>
        </div>
      </header>

      {viewMode === 'multi' && (
        <>
        {/* Der Plan steht ueber der Wand, nicht in einem Einstellungs-Reiter:
            er beschriftet genau die Kacheln darunter. */}
        <CameraPlanPanel planMatch={planMatch} onMatch={matchCameraPlan} onApply={applyCameraPlan} />
        <MultiCamPanel
          cameras={cameras}
          cameraStates={cameraStates}
          tally={tally}
          onAddCamera={addCamera}
          onConnect={connectCamera}
          onDisconnect={disconnectCamera}
          onRemove={removeCamera}
          onCommand={(num, cmd, params) => sendCommand(num, cmd, params)}
          onSetTally={(_num, t) => setTally(t)}
          onEdit={(num) => { setSelected(num); setViewMode('single'); }}
        />
        </>
      )}

      {viewMode === 'single' && (
      <main className="app__main app__main--rcp">
        <aside className="app__sidebar">
          {/* Camera list — every configured camera, live status */}
          <div className="panel camera-list">
            <div className="camera-list__head">
              <span className="panel__title">Cameras</span>
              <button className="btn btn--sm btn--primary" onClick={addCamera}>+ Camera</button>
            </div>
            {camNumbers.length === 0 && (
              <p className="camera-list__empty">No cameras yet. "+ Camera" adds one.</p>
            )}
            {camNumbers.map((n) => {
              const c = cameras[n];
              return (
                <div
                  key={n}
                  className={`camera-list__item ${selected === n ? 'camera-list__item--active' : ''}`}
                  onClick={() => setSelected(n)}
                >
                  <span className={`status-dot status-dot--${c.connected ? 'ok' : 'err'}`} />
                  <span className="camera-list__num">{n}</span>
                  <span className="camera-list__mode">{MODE_LABEL[c.config.connectionMode ?? 'tcp'] ?? c.config.connectionMode}</span>
                  <button
                    className="camera-list__remove"
                    title="Entfernen"
                    onClick={(e) => { e.stopPropagation(); removeCamera(n); }}
                  >✕</button>
                </div>
              );
            })}
          </div>

          {selected !== null && (
            <ConnectionPanel
              config={config}
              ports={ports}
              sonyUsbDevices={sonyUsbDevices}
              sonyMncDevices={sonyMncDevices}
              hidDevices={hidDevices}
              controlSurfaceActive={controlSurfaceActive}
              onSetConfig={(cfg) => setCameraConfig(selected, cfg)}
              onListPorts={listPorts}
              onDiscoverSonyUsb={discoverSonyUsb}
              onDiscoverSonyMnc={discoverSonyMnc}
              onListHidDevices={listHidDevices}
              onEnableControlSurface={enableControlSurface}
              onDisableControlSurface={disableControlSurface}
              onConnect={() => connectCamera(selected)}
              onDisconnect={() => disconnectCamera(selected)}
              cameraConnected={connected}
              wsStatus={status}
            />
          )}

          <WiznetPanel
            devices={wiznetDevices}
            onDiscover={discoverWiznet}
            onConfigure={configureWiznet}
            onSelectDevice={handleSelectWiznet}
          />

          {errorMsg && <div className="app__error-panel">{errorMsg}</div>}
        </aside>

        <div className="app__rcp">
          {selected === null ? (
            <div className="app__empty">Add a camera on the left to control it.</div>
          ) : (
            <>
              <div className="panel-view-tabs">
                <button className={`rcp-btn ${panelView === 'rcp' ? 'rcp-btn--primary' : 'rcp-btn--secondary'}`} onClick={() => setPanelView('rcp')}>
                  RCP (Bildregler)
                </button>
                <button className={`rcp-btn ${panelView === 'ptz' ? 'rcp-btn--primary' : 'rcp-btn--secondary'}`} onClick={() => setPanelView('ptz')}>
                  PTZ (Joystick)
                </button>
              </div>

              {panelView === 'ptz' ? (
                <PtzPanel cameraId={selected} disabled={!connected} onCommand={onCommand} />
              ) : (
                <SonyRcpPanel
                  state={shownState}
                  origins={shownOrigins}
                  confirmations={shownConfirmations}
                  freshnessLimits={cam?.freshnessLimits ?? null}
                  neverReadsBack={neverReadsBack}
                  tally={tally}
                  cameraId={selected}
                  disabled={!connected}
                  capabilities={capabilities}
                  onCommand={onCommand}
                  onSetTally={handleSetTally}
                />
              )}
            </>
          )}
        </div>
      </main>
      )}
    </div>
  );
}
