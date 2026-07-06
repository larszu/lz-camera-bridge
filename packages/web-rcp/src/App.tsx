import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useBridge } from './hooks/useBridge.ts';
import { ConnectionPanel } from './components/ConnectionPanel.tsx';
import { SonyRcpPanel } from './components/SonyRcpPanel.tsx';
import { PtzPanel } from './components/PtzPanel.tsx';
import { WiznetPanel } from './components/WiznetPanel.tsx';
import { FirstStartWizard, isWizardDone } from './components/FirstStartWizard.tsx';
import { capabilitiesForMode, isPtzMode } from './capabilities.ts';
import type { WiznetDevice } from './types.ts';
import type { TallyState } from './components/TallyBar.tsx';
import './styles/sony-rcp.css';
import './styles/wizard.css';
import './styles/ptz-panel.css';

type PanelView = 'rcp' | 'ptz';

/** Highest camera number selectable over a single Sony CCU/CNS connection. */
const MAX_CCU_CAMERAS = 8;

export default function App() {
  const [panelView, setPanelView] = useState<PanelView>('rcp');
  const [showWizard, setShowWizard] = useState(!isWizardDone());
  const [activeCam, setActiveCam] = useState(0);

  const {
    status,
    cameraConnected,
    state,
    cameraStates,
    config,
    ports,
    wiznetDevices,
    sonyUsbDevices,
    sonyMncDevices,
    hidDevices,
    controlSurfaceActive,
    tally,
    errorMsg,
    send,
    connectCamera,
    disconnectCamera,
    listPorts,
    setConfig,
    discoverWiznet,
    configureWiznet,
    discoverSonyUsb,
    discoverSonyMnc,
    listHidDevices,
    enableControlSurface,
    disableControlSurface,
    setTally,
  } = useBridge();

  // Sony CCU/CNS addresses several cameras by number over one connection.
  // Every other backend is a single camera, so the switcher only shows there.
  const isSonyCcu = config.connectionMode === 'tcp' || config.connectionMode === 'serial';

  useEffect(() => {
    setActiveCam(config.ccuId ?? 0);
  }, [config.ccuId]);

  // Commands target the selected camera number; state shown follows it too.
  const handleCommand = useCallback(
    (cmd: string, params: Record<string, unknown>) => {
      send('command', { cmd, params: { ...params, cameraNumber: activeCam } });
    },
    [send, activeCam],
  );

  const shownState = useMemo(
    () => cameraStates[activeCam] ?? state,
    [cameraStates, activeCam, state],
  );

  const handleSelectWiznet = useCallback(
    (device: WiznetDevice) => {
      setConfig({ connectionMode: 'tcp', tcpHost: device.ip, tcpPort: device.port });
    },
    [setConfig],
  );

  const handleSetTally = useCallback((t: Partial<TallyState>) => setTally(t), [setTally]);

  const handleWizardComplete = useCallback(
    (wizardConfig: Partial<typeof config>) => {
      setConfig(wizardConfig);
      setShowWizard(false);
    },
    [setConfig],
  );

  // PTZ heads default to the PTZ panel; paint-only cameras to the RCP.
  useEffect(() => {
    setPanelView(isPtzMode(config.connectionMode) ? 'ptz' : 'rcp');
  }, [config.connectionMode]);

  const capabilities = capabilitiesForMode(config.connectionMode);

  return (
    <div className="app">
      {showWizard && <FirstStartWizard onComplete={handleWizardComplete} />}
      <header className="app__header">
        <span className="app__title">Camera Bridge</span>
      </header>
      <main className="app__main app__main--rcp">
        <aside className="app__sidebar">
          <ConnectionPanel
            config={config}
            ports={ports}
            sonyUsbDevices={sonyUsbDevices}
            sonyMncDevices={sonyMncDevices}
            hidDevices={hidDevices}
            controlSurfaceActive={controlSurfaceActive}
            onSetConfig={setConfig}
            onListPorts={listPorts}
            onDiscoverSonyUsb={discoverSonyUsb}
            onDiscoverSonyMnc={discoverSonyMnc}
            onListHidDevices={listHidDevices}
            onEnableControlSurface={enableControlSurface}
            onDisableControlSurface={disableControlSurface}
            onConnect={connectCamera}
            onDisconnect={disconnectCamera}
            cameraConnected={cameraConnected}
            wsStatus={status}
          />

          <WiznetPanel
            devices={wiznetDevices}
            onDiscover={discoverWiznet}
            onConfigure={configureWiznet}
            onSelectDevice={handleSelectWiznet}
          />

          {errorMsg && <div className="app__error-panel">{errorMsg}</div>}
        </aside>

        <div className="app__rcp">
          {/* Multi-camera selector — addresses cameras by number over one
              Sony CCU/CNS connection (ported from the old dashboard). */}
          {isSonyCcu && (
            <div className="cam-switch">
              <span className="cam-switch__label">Kamera</span>
              {Array.from({ length: MAX_CCU_CAMERAS }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  className={`cam-switch__btn ${activeCam === n ? 'cam-switch__btn--active' : ''}`}
                  onClick={() => setActiveCam(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          )}

          <div className="panel-view-tabs">
            <button
              className={`rcp-btn ${panelView === 'rcp' ? 'rcp-btn--primary' : 'rcp-btn--secondary'}`}
              onClick={() => setPanelView('rcp')}
            >
              RCP (Bildregler)
            </button>
            <button
              className={`rcp-btn ${panelView === 'ptz' ? 'rcp-btn--primary' : 'rcp-btn--secondary'}`}
              onClick={() => setPanelView('ptz')}
            >
              PTZ (Joystick)
            </button>
          </div>

          {panelView === 'ptz' ? (
            <PtzPanel cameraId={activeCam} disabled={!cameraConnected} onCommand={handleCommand} />
          ) : (
            <SonyRcpPanel
              state={shownState}
              tally={tally}
              cameraId={activeCam}
              disabled={!cameraConnected}
              capabilities={capabilities}
              onCommand={handleCommand}
              onSetTally={handleSetTally}
            />
          )}
        </div>
      </main>
    </div>
  );
}
