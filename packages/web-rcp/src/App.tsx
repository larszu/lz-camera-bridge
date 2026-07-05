import React, { useCallback, useEffect, useState } from 'react';
import { useBridge } from './hooks/useBridge.ts';
import { ConnectionPanel } from './components/ConnectionPanel.tsx';
import { SonyRcpPanel } from './components/SonyRcpPanel.tsx';
import { PtzPanel } from './components/PtzPanel.tsx';
import { WiznetPanel } from './components/WiznetPanel.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { FirstStartWizard, isWizardDone } from './components/FirstStartWizard.tsx';
import { capabilitiesForMode, isPtzMode } from './capabilities.ts';
import type { CameraState, WiznetDevice } from './types.ts';
import type { TallyState } from './components/TallyBar.tsx';
import './styles/sony-rcp.css';
import './styles/wizard.css';
import './styles/ptz-panel.css';

type AppMode = 'single' | 'dashboard';
type PanelView = 'rcp' | 'ptz';

export default function App() {
  const [mode, setMode] = useState<AppMode>('dashboard');
  const [panelView, setPanelView] = useState<PanelView>('rcp');
  const [showWizard, setShowWizard] = useState(!isWizardDone());
  
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

  const handleCommand = useCallback(
    (cmd: string, params: Record<string, unknown>) => {
      send('command', { cmd, params });
    },
    [send],
  );

  const handleSelectWiznet = useCallback(
    (device: WiznetDevice) => {
      // Auto-fill TCP connection with selected WIZ108SR device
      setConfig({
        connectionMode: 'tcp',
        tcpHost: device.ip,
        tcpPort: device.port,
      });
    },
    [setConfig],
  );

  const handleSetTally = useCallback(
    (t: Partial<TallyState>) => {
      setTally(t);
    },
    [setTally],
  );

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

  // Dashboard mode - multi-camera RCP panels
  if (mode === 'dashboard') {
    return (
      <div className="app">
        {showWizard && <FirstStartWizard onComplete={handleWizardComplete} />}
        <header className="app__header">
          <button 
            className="rcp-btn rcp-btn--secondary"
            onClick={() => setMode('single')}
          >
            Single Camera Mode
          </button>
        </header>
        <Dashboard
          bridgeConnected={cameraConnected}
          remoteCameraStates={cameraStates}
          onSendCommand={(cameraId, cmd, params) => {
            const cameraNumber = Number(cameraId);
            send('command', { cmd, params: { ...params, cameraNumber } });
          }}
        />
      </div>
    );
  }

  // Single camera mode - legacy layout
  return (
    <div className="app">
      {showWizard && <FirstStartWizard onComplete={handleWizardComplete} />}
      <header className="app__header">
        <button 
          className="rcp-btn rcp-btn--primary"
          onClick={() => setMode('dashboard')}
        >
          Multi-Camera Dashboard
        </button>
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
          <div className="panel-view-tabs" style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
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
            <PtzPanel
              cameraId={config.ccuId ?? 1}
              disabled={!cameraConnected}
              onCommand={handleCommand}
            />
          ) : (
            <SonyRcpPanel
              state={state}
              tally={tally}
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
