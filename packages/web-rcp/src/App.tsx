import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useBridge } from './hooks/useBridge.ts';
import { ConnectionPanel } from './components/ConnectionPanel.tsx';
import { SonyRcpPanel } from './components/SonyRcpPanel.tsx';
import { PtzPanel, type PtzExtras } from './components/PtzPanel.tsx';
import { MultiCamPanel } from './components/MultiCamPanel.tsx';
import { CameraPlanPanel } from './components/CameraPlanPanel.tsx';
import { WiznetPanel } from './components/WiznetPanel.tsx';
import { SwitcherPanel } from './components/SwitcherPanel.tsx';
import { SwitcherConfigPanel } from './components/SwitcherConfigPanel.tsx';
import { VideoWall } from './components/VideoWall.tsx';
import { SitePanel } from './components/SitePanel.tsx';
import { PlannedShots } from './components/PlannedShots.tsx';
import { FirstStartWizard, isWizardDone } from './components/FirstStartWizard.tsx';
import { capabilitiesForMode, isPtzMode } from './capabilities.ts';
import type { BridgeConfig, WiznetDevice } from './types.ts';
import type { TallyState } from './components/TallyBar.tsx';
import './styles/sony-rcp.css';
import './styles/wizard.css';
import './styles/ptz-panel.css';
import './styles/regie.css';

type PanelView = 'rcp' | 'ptz';
/** The five views. `single`/`multi` are the panel; the other three came with the control room. */
type ViewMode = 'single' | 'multi' | 'switcher' | 'video' | 'site';

const VIEW_KEY = 'lz-bridge.view';
const VIEWS: { id: ViewMode; label: string }[] = [
  { id: 'single', label: 'Cameras' },
  { id: 'multi', label: 'Wall' },
  { id: 'switcher', label: 'Switcher' },
  { id: 'video', label: 'Video' },
  { id: 'site', label: 'Site' },
];

export const MODE_LABEL: Record<string, string> = {
  tcp: 'Sony CCU', serial: 'Sony RS-422', 'sony-usb': 'Sony USB', 'sony-mnc': 'Sony WiFi',
  'lumix-http': 'Lumix', 'canon-ccapi': 'Canon', blackmagic: 'Blackmagic', zcam: 'Z CAM',
  'panasonic-ptz': 'Pana PTZ', visca: 'VISCA', 'visca-serial': 'VISCA RS-232', jvc: 'JVC', birddog: 'BirdDog',
  'http-cgi': 'HTTP-CGI', 'dji-osmo': 'DJI Osmo', 'dji-ronin': 'DJI Ronin', 'b4-lens': 'B4 lens', demo: 'Demo',
};

const newCameraConfig = (num: number): BridgeConfig => ({
  connectionMode: 'tcp', tcpHost: '192.168.1.10', tcpPort: 7700, ccuId: num,
});

/** What the PTZ panel may show beyond the AW-RP150 set — read off the backend, not wished for. */
export function ptzExtrasFor(config: BridgeConfig): PtzExtras {
  if (config.connectionMode !== 'http-cgi') return {};
  return { home: true, osd: config.cgiFamily !== 'sony', power: true, manualFocus: true };
}

function initialView(): { view: ViewMode; bare: boolean } {
  const q = new URLSearchParams(window.location.search);
  const fromUrl = q.get('view') as ViewMode | null;
  if (fromUrl && VIEWS.some((v) => v.id === fromUrl)) return { view: fromUrl, bare: q.get('bare') === '1' };
  try {
    const saved = localStorage.getItem(VIEW_KEY) as ViewMode | null;
    if (saved && VIEWS.some((v) => v.id === saved)) return { view: saved, bare: false };
  } catch { /* per-viewer convenience only */ }
  return { view: 'single', bare: false };
}

export default function App() {
  const [{ view: firstView, bare }] = useState(initialView);
  const [panelView, setPanelView] = useState<PanelView>('rcp');
  const [viewMode, setViewModeState] = useState<ViewMode>(firstView);
  const [showWizard, setShowWizard] = useState(!bare && !isWizardDone());
  const [selected, setSelected] = useState<number | null>(null);

  const setViewMode = useCallback((v: ViewMode) => {
    setViewModeState(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ }
  }, []);

  const bridge = useBridge();
  const {
    status, cameras, cameraStates, cameraOrigins, cameraConfirmations, ports, wiznetDevices, sonyUsbDevices, sonyMncDevices,
    hidDevices, controlSurfaceActive, tally, errorMsg, planMatch,
    switchers, cameraTally, site,
    setCameraConfig, connectCamera, disconnectCamera, removeCamera, sendCommand,
    listPorts, discoverWiznet, configureWiznet, discoverSonyUsb, discoverSonyMnc,
    listHidDevices, enableControlSurface, disableControlSurface, setTally,
    matchCameraPlan, applyCameraPlan,
    setSwitcherConfig, connectSwitcher, disconnectSwitcher, removeSwitcher, switcherCommand,
    importSite, setSiteName, clearError,
    poses, plannedProgress, readPose, drivePlannedPreset, storePlannedPresets, calibratePose, setPoseOffset,
    zoomTo, captureZoomPoint, clearZoomTable,
  } = bridge;

  const camNumbers = useMemo(
    () => Object.keys(cameras).map(Number).sort((a, b) => a - b),
    [cameras],
  );
  // One switcher per room is the case this was built for; the bridge allows more.
  const switcherNum = useMemo(() => Object.keys(switchers).map(Number).sort((a, b) => a - b)[0] ?? null, [switchers]);
  const switcher = switcherNum !== null ? switchers[switcherNum] : null;
  const onSwitcherCommand = useCallback(
    (cmd: string, params: Record<string, unknown> = {}) => { if (switcherNum !== null) switcherCommand(switcherNum, cmd, params); },
    [switcherNum, switcherCommand],
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
    setViewMode('single');
  }, [camNumbers, setCameraConfig, setViewMode]);

  const addSwitcher = useCallback(() => {
    setSwitcherConfig(1, { kind: 'vis-catc', path: 'http', port: 80 });
    setViewMode('switcher');
  }, [setSwitcherConfig, setViewMode]);

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
  const capabilities = capabilitiesForMode(config.connectionMode, config.cgiFamily);

  useEffect(() => {
    setPanelView(isPtzMode(config.connectionMode) ? 'ptz' : 'rcp');
  }, [config.connectionMode, selected]);

  const onCommand = useCallback(
    (cmd: string, params: Record<string, unknown>) => {
      if (selected !== null) sendCommand(selected, cmd, params);
    },
    [selected, sendCommand],
  );

  // Keyboard on the PTZ panel: arrows drive while held, 1..9 recall, Home goes home.
  // Blur stops the head — a key released while the window is away sends no keyup.
  const ptzKeysActive = viewMode === 'single' && panelView === 'ptz' && connected && !showWizard;
  useEffect(() => {
    if (!ptzKeysActive || selected === null) return;
    const held = new Set<string>();
    const target = selected;
    const drive = () => {
      const pan = (held.has('ArrowRight') ? 1 : 0) - (held.has('ArrowLeft') ? 1 : 0);
      const tilt = (held.has('ArrowUp') ? 1 : 0) - (held.has('ArrowDown') ? 1 : 0);
      sendCommand(target, 'ptz', { pan: pan * 60, tilt: tilt * 60 });
    };
    const inField = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (inField(e)) return;
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        if (e.repeat) return;
        held.add(e.key);
        drive();
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        sendCommand(target, 'recallPreset', { value: Number(e.key) });
      } else if (e.key === 'Home') {
        sendCommand(target, 'home', {});
      }
    };
    const up = (e: KeyboardEvent) => {
      if (!held.has(e.key)) return;
      held.delete(e.key);
      drive();
    };
    const stopAll = () => {
      if (held.size === 0) return;
      held.clear();
      sendCommand(target, 'ptz', { pan: 0, tilt: 0 });
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stopAll);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stopAll);
      stopAll();
    };
  }, [ptzKeysActive, selected, sendCommand]);

  if (bare) {
    return (
      <VideoWall cameras={cameras} cameraTally={cameraTally} switcher={switcher} onSwitcherCommand={onSwitcherCommand} bare />
    );
  }

  const streams = camNumbers.filter((n) => cameras[n].config.streamUrl).length;

  return (
    <div className="app">
      {showWizard && <FirstStartWizard onComplete={handleWizardComplete} />}
      <header className="app__header">
        <span className="app__title">LZ Camera Bridge</span>
        <span className={`app__ws status-dot status-dot--${status === 'connected' ? 'ok' : 'err'}`} title={`Bridge: ${status}`} />
        {site.name && <span className="app__site" title="Site">{site.name}</span>}
        <nav className="nav" aria-label="Views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`nav__tab ${viewMode === v.id ? 'nav__tab--active' : ''}`}
              onClick={() => setViewMode(v.id)}
              aria-current={viewMode === v.id ? 'page' : undefined}
            >
              {v.label}
              {v.id === 'single' && camNumbers.length > 0 && <span className="nav__count">{camNumbers.length}</span>}
              {v.id === 'video' && streams > 0 && <span className="nav__count">{streams}</span>}
              {v.id === 'switcher' && switcher?.connected && <span className="nav__count">●</span>}
            </button>
          ))}
        </nav>
      </header>

      {errorMsg && viewMode !== 'single' && (
        <div className="error-line" role="alert">
          <span>{errorMsg}</span>
          <button className="btn btn--sm" onClick={clearError}>Dismiss</button>
        </div>
      )}

      {viewMode === 'multi' && (
        <>
        {/* Der Plan steht ueber der Wand, nicht in einem Einstellungs-Reiter:
            er beschriftet genau die Kacheln darunter. */}
        <CameraPlanPanel planMatch={planMatch} onMatch={matchCameraPlan} onApply={applyCameraPlan} />
        <MultiCamPanel
          cameras={cameras}
          cameraStates={cameraStates}
          tally={tally}
          cameraTally={cameraTally}
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

      {viewMode === 'switcher' && (
        <main className="view">
          {switcher ? (
            <div className="view__grid">
              <SwitcherPanel
                switcher={switcher}
                cameras={cameras}
                onCommand={onSwitcherCommand}
                onConnect={() => connectSwitcher(switcher.switcherNumber)}
                onDisconnect={() => disconnectSwitcher(switcher.switcherNumber)}
                keysActive={!showWizard}
              />
              <SwitcherConfigPanel
                key={switcher.switcherNumber}
                switcher={switcher}
                ports={ports}
                onListPorts={listPorts}
                onSetConfig={(cfg) => setSwitcherConfig(switcher.switcherNumber, cfg)}
                onConnect={() => connectSwitcher(switcher.switcherNumber)}
                onRemove={() => removeSwitcher(switcher.switcherNumber)}
              />
            </div>
          ) : (
            <div className="empty">
              No switcher yet. A Vissonic VIS-CATC can be driven over its network page or over RS-232.
              <br />
              <button className="btn btn--primary" onClick={addSwitcher}>+ Switcher</button>
            </div>
          )}
        </main>
      )}

      {viewMode === 'video' && (
        <main className="view">
          <VideoWall
            cameras={cameras}
            cameraTally={cameraTally}
            switcher={switcher}
            onSwitcherCommand={onSwitcherCommand}
            onEdit={(num) => { setSelected(num); setViewMode('single'); }}
          />
        </main>
      )}

      {viewMode === 'site' && (
        <main className="view">
          <SitePanel
            site={site}
            cameras={cameras}
            switchers={switchers}
            bridgeConnected={status === 'connected'}
            onSetName={setSiteName}
            onImport={importSite}
            onEditCamera={(num) => { if (num === 0) addCamera(); else { setSelected(num); setViewMode('single'); } }}
            onAddSwitcher={addSwitcher}
            onEditSwitcher={() => setViewMode('switcher')}
          />
        </main>
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
              const t = cameraTally[n];
              return (
                <div
                  key={n}
                  className={`camera-list__item ${selected === n ? 'camera-list__item--active' : ''}`}
                  onClick={() => setSelected(n)}
                >
                  <span className={`status-dot status-dot--${c.connected ? 'ok' : 'err'}`} />
                  <span className="camera-list__num">{n}</span>
                  <span className="camera-list__mode">
                    {c.plan?.label ?? c.config.label ?? MODE_LABEL[c.config.connectionMode ?? 'tcp'] ?? c.config.connectionMode}
                  </span>
                  {t && t !== 'off' && <span className={`tile__tally tile__tally--${t}`}>{t === 'program' ? 'PGM' : 'PVW'}</span>}
                  <button
                    className="camera-list__remove"
                    title="Remove"
                    onClick={(e) => { e.stopPropagation(); removeCamera(n); }}
                  >✕</button>
                </div>
              );
            })}
          </div>

          {selected !== null && (
            <ConnectionPanel
              key={selected}
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
                  RCP (paint)
                </button>
                <button className={`rcp-btn ${panelView === 'ptz' ? 'rcp-btn--primary' : 'rcp-btn--secondary'}`} onClick={() => setPanelView('ptz')}>
                  PTZ (joystick)
                </button>
              </div>

              {panelView === 'ptz' ? (
                <>
                  <PtzPanel
                    cameraId={selected}
                    label={cam?.plan?.label ?? cam?.config.label}
                    disabled={!connected}
                    onCommand={onCommand}
                    extras={ptzExtrasFor(config)}
                    power={shownState.cameraPower}
                    tally={cameraTally[selected]}
                  />
                  {cam && (
                    <PlannedShots
                      cam={cam}
                      connected={connected}
                      pose={poses[selected]}
                      progress={plannedProgress[selected]}
                      onDrive={(n) => drivePlannedPreset(selected, n)}
                      onStoreAll={() => storePlannedPresets(selected)}
                      onCalibrate={(n) => calibratePose(selected, n)}
                      onClearOffset={() => setPoseOffset(selected, null)}
                      onReadPose={() => readPose(selected)}
                      onZoomTo={(z) => zoomTo(selected, z)}
                      onCaptureZoom={(mm) => captureZoomPoint(selected, mm)}
                      onClearZoomTable={() => clearZoomTable(selected)}
                    />
                  )}
                </>
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
