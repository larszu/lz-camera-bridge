import React, { useState, useCallback, useEffect } from 'react';
import { SonyRcpPanel } from './SonyRcpPanel.tsx';
import { BlackmagicRcpPanel } from './BlackmagicRcpPanel.tsx';
import { CameraConfigPanel } from './CameraConfigPanel.tsx';
import type {
  CameraCapabilities,
  CameraConnection,
  CameraProtocol,
  CameraType,
  TallyState,
  CameraState,
  DashboardState,
  CameraStatesByNumber,
} from '../types.ts';
import type { CameraSetupDraft } from './CameraConfigPanel.tsx';

const generateId = () => Math.random().toString(36).substring(2, 9);

const BRIDGE_PROTOCOLS = new Set<CameraProtocol>([
  'sony-700ptp',
  'sony-700spp',
  'sony-crsdk',
  'sony-mnc',
  'lumix-http',
]);

const defaultCameraState: CameraState = {
  iris: 128,
  masterBlack: 128,
  blackR: 128,
  blackG: 128,
  blackB: 128,
  whiteR: 128,
  whiteG: 128,
  whiteB: 128,
  masterGain: 0,
  masterGamma: 128,
  saturation: 128,
  shutterSpeed: 0,
  bars: false,
  cameraPower: true,
  ndFilter: 0,
  detailLevel: 128,
};

const defaultTallyState: TallyState = {
  program: false,
  preview: false,
  isoRec: false,
};

const ALL_CAPABILITIES_ENABLED: CameraCapabilities = {
  call: true,
  bars: true,
  colorTemp: true,
  character: true,
  masterGain: true,
  awb: true,
  abb: true,
  whiteBalance: true,
  blackBalance: true,
  masterBlack: true,
  masterGamma: true,
  autoIris: true,
  iris: true,
  ndFilter: true,
  cc: true,
  tallyProgram: true,
  tallyPreview: true,
  record: true,
  iso: true,
  shutter: true,
  focus: true,
  contrast: true,
  saturation: true,
  resetCc: true,
};

const PROTOCOL_CAPABILITY_OVERRIDES: Partial<Record<CameraProtocol, Partial<CameraCapabilities>>> = {
  'sony-700ptp': {
    record: false,
    iso: false,
    shutter: false,
    focus: false,
    contrast: false,
    resetCc: false,
  },
  'sony-700spp': {
    record: false,
    iso: false,
    shutter: false,
    focus: false,
    contrast: false,
    resetCc: false,
  },
  'sony-crsdk': {
    bars: false,
    character: false,
    blackBalance: false,
    masterBlack: false,
    masterGamma: false,
    ndFilter: false,
    cc: false,
    contrast: false,
    resetCc: false,
  },
  'sony-mnc': {
    bars: false,
    call: false,
    character: false,
    abb: false,
    blackBalance: false,
    masterBlack: false,
    masterGamma: false,
    ndFilter: false,
    cc: false,
    contrast: false,
    resetCc: false,
  },
  'lumix-http': {
    call: false,
    bars: false,
    character: false,
    abb: false,
    blackBalance: false,
    masterBlack: false,
    masterGamma: false,
    autoIris: false,
    ndFilter: false,
    cc: false,
    record: false,
    contrast: false,
    resetCc: false,
  },
  'blackmagic-rest': {
    call: false,
    bars: false,
    character: false,
    awb: true,
    abb: false,
    autoIris: false,
    ndFilter: false,
    cc: false,
    tallyPreview: false,
    colorTemp: false,
  },
  'blackmagic-sdi': {
    call: false,
    bars: false,
    character: false,
    awb: true,
    abb: false,
    autoIris: false,
    ndFilter: false,
    cc: false,
    tallyPreview: false,
    colorTemp: false,
  },
  manual: {
    call: false,
    bars: false,
    colorTemp: false,
    character: false,
    masterGain: false,
    awb: false,
    abb: false,
    whiteBalance: false,
    blackBalance: false,
    masterBlack: false,
    masterGamma: false,
    autoIris: false,
    iris: false,
    ndFilter: false,
    cc: false,
    record: false,
    iso: false,
    shutter: false,
    focus: false,
    contrast: false,
    saturation: false,
    resetCc: false,
  },
};

function protocolToType(protocol: CameraProtocol): CameraType {
  if (protocol.startsWith('blackmagic')) return 'blackmagic';
  if (protocol === 'lumix-http') return 'lumix';
  return 'sony';
}

function defaultNameFor(type: CameraType, cameraNumber: number): string {
  if (type === 'blackmagic') return `Blackmagic Camera ${cameraNumber}`;
  if (type === 'lumix') return `Lumix Camera ${cameraNumber}`;
  return `Sony Camera ${cameraNumber}`;
}

function capabilitiesForProtocol(protocol: CameraProtocol): CameraCapabilities {
  return {
    ...ALL_CAPABILITIES_ENABLED,
    ...(PROTOCOL_CAPABILITY_OVERRIDES[protocol] ?? {}),
  };
}

function createCameraFromDraft(draft: CameraSetupDraft): CameraConnection {
  return {
    id: generateId(),
    name: draft.name,
    cameraNumber: draft.cameraNumber,
    type: draft.type,
    protocol: draft.protocol,
    status: 'disconnected',
    settings: { ...draft.settings },
    state: { ...defaultCameraState },
    tally: { ...defaultTallyState },
    capabilities: capabilitiesForProtocol(draft.protocol),
  };
}

interface DashboardProps {
  bridgeConnected?: boolean;
  remoteCameraStates?: CameraStatesByNumber;
  onSendCommand?: (cameraId: string, cmd: string, params: Record<string, unknown>) => void;
}

/**
 * Multi-camera RCP dashboard with unified camera setup flow.
 */
export function Dashboard({ bridgeConnected = false, remoteCameraStates = {}, onSendCommand }: DashboardProps) {
  const [state, setState] = useState<DashboardState>(() => {
    const firstDraft: CameraSetupDraft = {
      name: defaultNameFor('sony', 1),
      cameraNumber: 1,
      type: 'sony',
      protocol: 'sony-700ptp',
      settings: { host: '192.168.1.100', port: 7700, serialPath: 'COM3', baudRate: 38400, parity: 'odd' },
    };

    return {
      cameras: [createCameraFromDraft(firstDraft)],
      selectedCameraId: null,
      companionEnabled: true,
      companionPort: 9702,
    };
  });

  const [showConfig, setShowConfig] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  useEffect(() => {
    setState((prev) => ({
      ...prev,
      cameras: prev.cameras.map((camera) => {
        const hasRemoteState = Object.prototype.hasOwnProperty.call(remoteCameraStates, camera.cameraNumber);
        let nextStatus = camera.status;

        if (BRIDGE_PROTOCOLS.has(camera.protocol)) {
          if (hasRemoteState) {
            nextStatus = 'connected';
          } else if (!bridgeConnected) {
            nextStatus = camera.status === 'error' ? 'error' : 'disconnected';
          } else if (camera.status !== 'connecting') {
            // Bridge is reachable, but camera has not reported state yet.
            nextStatus = 'disconnected';
          }
        }

        return {
          ...camera,
          status: nextStatus,
          state: {
            ...camera.state,
            ...(remoteCameraStates[camera.cameraNumber] ?? {}),
          },
        };
      }),
    }));
  }, [bridgeConnected, remoteCameraStates]);

  const nextCameraNumber = state.cameras.length > 0
    ? Math.max(...state.cameras.map((c) => c.cameraNumber)) + 1
    : 1;

  const addCamera = useCallback((draft: CameraSetupDraft) => {
    setState((prev) => ({
      ...prev,
      cameras: [...prev.cameras, createCameraFromDraft(draft)],
    }));
  }, []);

  const removeCamera = useCallback((id: string) => {
    setState((prev) => ({
      ...prev,
      cameras: prev.cameras.filter((c) => c.id !== id),
      selectedCameraId: prev.selectedCameraId === id ? null : prev.selectedCameraId,
    }));
  }, []);

  const updateCamera = useCallback((id: string, updates: Partial<CameraConnection>) => {
    setState((prev) => ({
      ...prev,
      cameras: prev.cameras.map((c) => {
        if (c.id !== id) return c;

        const nextProtocol = updates.protocol ?? c.protocol;
        const nextType = updates.type ?? protocolToType(nextProtocol);

        return {
          ...c,
          ...updates,
          protocol: nextProtocol,
          type: nextType,
          capabilities: capabilitiesForProtocol(nextProtocol),
        };
      }),
    }));
  }, []);

  const handleCommand = useCallback((cameraId: string, cmd: string, params: Record<string, unknown>) => {
    setState((prev) => ({
      ...prev,
      cameras: prev.cameras.map((c) => {
        if (c.id !== cameraId) return c;

        const stateUpdates: Partial<CameraState> = {};
        switch (cmd) {
          case 'setIris':
            stateUpdates.iris = params.value as number;
            break;
          case 'setMasterBlack':
            stateUpdates.masterBlack = params.value as number;
            break;
          case 'setBlackBalance':
            if (params.r !== undefined) stateUpdates.blackR = params.r as number;
            if (params.g !== undefined) stateUpdates.blackG = params.g as number;
            if (params.b !== undefined) stateUpdates.blackB = params.b as number;
            break;
          case 'setWhiteBalance':
            if (params.r !== undefined) stateUpdates.whiteR = params.r as number;
            if (params.g !== undefined) stateUpdates.whiteG = params.g as number;
            if (params.b !== undefined) stateUpdates.whiteB = params.b as number;
            break;
          case 'setMasterGain':
            stateUpdates.masterGain = params.value as number;
            break;
          case 'setMasterGamma':
            stateUpdates.masterGamma = params.value as number;
            break;
          case 'setSaturation':
            stateUpdates.saturation = params.value as number;
            break;
          case 'setShutterSpeed':
            stateUpdates.shutterSpeed = params.value as number;
            break;
          case 'setNdFilter':
            stateUpdates.ndFilter = params.value as number;
            break;
          case 'setBars':
            stateUpdates.bars = params.on as boolean;
            break;
        }

        return {
          ...c,
          state: { ...c.state, ...stateUpdates },
        };
      }),
    }));

    const targetCamera = state.cameras.find((camera) => camera.id === cameraId);
    if (!targetCamera) return;

    // Keep local-only protocols local to avoid pretending unsupported backend functionality.
    if (!BRIDGE_PROTOCOLS.has(targetCamera.protocol)) {
      return;
    }

    onSendCommand?.(String(targetCamera.cameraNumber), cmd, params);
  }, [onSendCommand, state.cameras]);

  const handleSetTally = useCallback((cameraId: string, tally: Partial<TallyState>) => {
    setState((prev) => ({
      ...prev,
      cameras: prev.cameras.map((c) =>
        c.id === cameraId
          ? { ...c, tally: { ...c.tally, ...tally } }
          : c,
      ),
    }));
  }, []);

  const toggleConnection = useCallback((cameraId: string) => {
    setState((prev) => ({
      ...prev,
      cameras: prev.cameras.map((c) => {
        if (c.id !== cameraId) return c;
        if (c.status === 'connected') return { ...c, status: 'disconnected' };
        if (c.status === 'disconnected') return { ...c, status: 'connecting' };
        return c;
      }),
    }));

    setTimeout(() => {
      setState((prev) => ({
        ...prev,
        cameras: prev.cameras.map((c) => {
          if (c.id !== cameraId || c.status !== 'connecting') return c;
          // Bridge-backed protocols resolve to 'connected' once the bridge
          // reports state (see the remoteCameraStates effect) — don't fake it.
          if (BRIDGE_PROTOCOLS.has(c.protocol)) return c;
          // 'manual' is an explicit no-backend demo mode the user chose.
          if (c.protocol === 'manual') return { ...c, status: 'connected' };
          // Everything else has no wired backend yet — be honest, don't pretend.
          return { ...c, status: 'error', error: 'Über Bridge nicht verbunden' };
        }),
      }));
    }, 700);
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent, cameraId: string) => {
    setDraggedId(cameraId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) return;

    setState((prev) => {
      const cameras = [...prev.cameras];
      const draggedIndex = cameras.findIndex((c) => c.id === draggedId);
      const targetIndex = cameras.findIndex((c) => c.id === targetId);
      if (draggedIndex === -1 || targetIndex === -1) return prev;

      const [draggedCamera] = cameras.splice(draggedIndex, 1);
      cameras.splice(targetIndex, 0, draggedCamera);
      return { ...prev, cameras };
    });

    setDraggedId(null);
  }, [draggedId]);

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
  }, []);

  const isBlackmagicCamera = (camera: CameraConnection) =>
    camera.protocol === 'blackmagic-rest' || camera.protocol === 'blackmagic-sdi';

  return (
    <div className="dashboard">
      <div className="dashboard__header">
        <div className="dashboard__title">
          <span>📹</span>
          <span>Camera Bridge Dashboard</span>
        </div>
        <div className="dashboard__actions">
          <button className="rcp-btn rcp-btn--primary" onClick={() => setShowCreate(true)}>
            + Add Camera
          </button>
        </div>
      </div>

      <div className="dashboard__body">
        <div className="dashboard__sidebar">
          <div className="dashboard__sidebar-header">
            Cameras ({state.cameras.length})
          </div>
          <div className="dashboard__camera-list">
            {state.cameras.map((camera) => (
              <div
                key={camera.id}
                className={`camera-card ${
                  state.selectedCameraId === camera.id ? 'camera-card--selected' : ''
                } ${
                  camera.status === 'connected' ? 'camera-card--connected' : ''
                } ${
                  camera.status === 'error' ? 'camera-card--error' : ''
                }`}
                onClick={() => setState((prev) => ({ ...prev, selectedCameraId: camera.id }))}
              >
                <div className="camera-card__icon">{camera.cameraNumber}</div>
                <div className="camera-card__info">
                  <div className="camera-card__name">{camera.name}</div>
                  <div className={`camera-card__status camera-card__status--${camera.status}`}>
                    {camera.status === 'connected' && '● Connected'}
                    {camera.status === 'connecting' && '○ Connecting...'}
                    {camera.status === 'disconnected' && '○ Disconnected'}
                    {camera.status === 'error' && `● ${camera.error || 'Error'}`}
                  </div>
                </div>
                <button
                  className="rcp-btn rcp-btn--sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowConfig(camera.id);
                  }}
                >
                  ⚙
                </button>
              </div>
            ))}
          </div>
          <button className="add-camera-btn" onClick={() => setShowCreate(true)}>
            <span>+</span>
            <span>Add Camera</span>
          </button>
        </div>

        <div className="dashboard__main dashboard__main--grid">
          {state.cameras.map((camera) => (
            <div
              key={camera.id}
              className={`dashboard__rcp-wrapper ${draggedId === camera.id ? 'dashboard__rcp-wrapper--dragging' : ''} ${isBlackmagicCamera(camera) ? 'dashboard__rcp-wrapper--blackmagic' : 'dashboard__rcp-wrapper--sony'}`}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, camera.id)}
            >
              <div
                className="dashboard__rcp-drag-handle"
                title="Drag to reorder"
                draggable
                onDragStart={(e) => handleDragStart(e, camera.id)}
                onDragEnd={handleDragEnd}
              >
                ⋮⋮
              </div>
              {isBlackmagicCamera(camera) ? (
                <BlackmagicRcpPanel
                  state={camera.state}
                  tally={camera.tally}
                  cameraId={camera.cameraNumber}
                  disabled={camera.status !== 'connected'}
                  capabilities={camera.capabilities}
                  onCommand={(cmd, params) => handleCommand(camera.id, cmd, params)}
                  onSetTally={(tally) => handleSetTally(camera.id, tally)}
                />
              ) : (
                <SonyRcpPanel
                  state={camera.state}
                  tally={camera.tally}
                  cameraId={camera.cameraNumber}
                  disabled={camera.status !== 'connected'}
                  capabilities={camera.capabilities}
                  onCommand={(cmd, params) => handleCommand(camera.id, cmd, params)}
                  onSetTally={(tally) => handleSetTally(camera.id, tally)}
                />
              )}
              <div className="dashboard__rcp-footer">
                <span className="dashboard__rcp-name">{camera.name}</span>
                <button
                  className={`rcp-btn rcp-btn--sm ${camera.status === 'connected' ? 'rcp-btn--green' : ''}`}
                  onClick={() => toggleConnection(camera.id)}
                >
                  {camera.status === 'connected' ? 'Disconnect' : 'Connect'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showCreate && (
        <CameraConfigPanel
          mode="create"
          initialCameraNumber={nextCameraNumber}
          onCreate={addCamera}
          onClose={() => setShowCreate(false)}
        />
      )}

      {showConfig && (
        <CameraConfigPanel
          mode="edit"
          camera={state.cameras.find((c) => c.id === showConfig)}
          onUpdate={(updates) => updateCamera(showConfig, updates)}
          onDelete={() => {
            removeCamera(showConfig);
            setShowConfig(null);
          }}
          onClose={() => setShowConfig(null)}
        />
      )}
    </div>
  );
}
