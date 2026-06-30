import React, { useMemo, useState } from 'react';
import type { CameraConnection, CameraProtocol, CameraType } from '../types.ts';

export interface CameraSetupDraft {
  name: string;
  cameraNumber: number;
  type: CameraType;
  protocol: CameraProtocol;
  settings: CameraConnection['settings'];
}

interface CameraConfigPanelProps {
  mode: 'create' | 'edit';
  camera?: CameraConnection;
  initialCameraNumber?: number;
  onCreate?: (draft: CameraSetupDraft) => void;
  onUpdate?: (updates: Partial<CameraConnection>) => void;
  onDelete?: () => void;
  onClose: () => void;
}

const PROTOCOLS: { value: CameraProtocol; label: string; description: string }[] = [
  {
    value: 'sony-700ptp',
    label: 'Sony 700PTP (TCP)',
    description: 'Sony 700 Protocol over TCP/IP - BRC/BVP'
  },
  {
    value: 'sony-700spp',
    label: 'Sony 700SPP (RS-422)',
    description: 'Sony 700 Protocol over RS-422 serial'
  },
  {
    value: 'sony-crsdk',
    label: 'Sony USB (PTP)',
    description: 'USB-Steuerung für FX3/FX6/FX9/A7/ZV via PTP – kein SDK nötig'
  },
  {
    value: 'sony-mnc',
    label: 'Sony Monitor & Control',
    description: 'WiFi protocol for supported Sony cameras'
  },
  {
    value: 'lumix-http',
    label: 'Panasonic Lumix HTTP',
    description: 'Lumix HTTP CGI over WiFi/LAN (S1/S5/GH5/GH6/BGH1)'
  },
  {
    value: 'blackmagic-rest',
    label: 'Blackmagic REST API',
    description: 'Ethernet/WiFi control for BMPCC/Studio cameras'
  },
  {
    value: 'blackmagic-sdi',
    label: 'Blackmagic SDI (ATEM)',
    description: 'Camera control via ATEM over SDI'
  },
  {
    value: 'manual',
    label: 'Manual / Demo',
    description: 'No camera connection - for demo/testing'
  },
];

function protocolToType(protocol: CameraProtocol): CameraType {
  if (protocol.startsWith('blackmagic')) return 'blackmagic';
  if (protocol === 'lumix-http') return 'lumix';
  return 'sony';
}

function defaultNameFor(protocol: CameraProtocol, number: number): string {
  const type = protocolToType(protocol);
  if (type === 'blackmagic') return `Blackmagic Camera ${number}`;
  if (type === 'lumix') return `Lumix Camera ${number}`;
  return `Sony Camera ${number}`;
}

/**
 * Unified camera setup panel (create + edit).
 * Uses one consistent workflow across all supported camera protocols.
 */
export function CameraConfigPanel({
  mode,
  camera,
  initialCameraNumber = 1,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: CameraConfigPanelProps) {
  const initialProtocol: CameraProtocol = camera?.protocol ?? 'sony-700ptp';
  const [localState, setLocalState] = useState<CameraSetupDraft>({
    name: camera?.name ?? defaultNameFor(initialProtocol, initialCameraNumber),
    cameraNumber: camera?.cameraNumber ?? initialCameraNumber,
    type: camera?.type ?? protocolToType(initialProtocol),
    protocol: initialProtocol,
    settings: {
      host: camera?.settings.host ?? (initialProtocol === 'lumix-http' ? '192.168.54.1' : '192.168.1.100'),
      port: camera?.settings.port ?? (initialProtocol === 'blackmagic-rest' ? 80 : initialProtocol === 'lumix-http' ? 80 : 7700),
      serialPath: camera?.settings.serialPath ?? 'COM3',
      baudRate: camera?.settings.baudRate ?? 38400,
      parity: camera?.settings.parity ?? 'odd',
      usbDeviceId: camera?.settings.usbDeviceId ?? '',
      wiznetMac: camera?.settings.wiznetMac ?? '',
    },
  });

  const isCreate = mode === 'create';

  const selectedProtocolMeta = useMemo(
    () => PROTOCOLS.find((p) => p.value === localState.protocol),
    [localState.protocol],
  );

  const setProtocol = (protocol: CameraProtocol) => {
    setLocalState((prev) => {
      const nextType = protocolToType(protocol);
      const nameNeedsAutofill = prev.name.trim().length === 0 || prev.name === defaultNameFor(prev.protocol, prev.cameraNumber);
      return {
        ...prev,
        protocol,
        type: nextType,
        name: nameNeedsAutofill ? defaultNameFor(protocol, prev.cameraNumber) : prev.name,
        settings: {
          ...prev.settings,
          port:
            protocol === 'blackmagic-rest' ? 80
            : protocol === 'lumix-http' ? 80
            : protocol === 'sony-700ptp' || protocol === 'sony-mnc' ? 7700
            : prev.settings.port,
        },
      };
    });
  };

  const updateSettings = (key: keyof CameraConnection['settings'], value: unknown) => {
    setLocalState((prev) => ({
      ...prev,
      settings: { ...prev.settings, [key]: value },
    }));
  };

  const handleSave = () => {
    if (isCreate) {
      onCreate?.(localState);
    } else {
      onUpdate?.({
        name: localState.name,
        cameraNumber: localState.cameraNumber,
        type: localState.type,
        protocol: localState.protocol,
        settings: localState.settings,
      });
    }
    onClose();
  };

  const showTcp = localState.protocol === 'sony-700ptp' || localState.protocol === 'sony-mnc' || localState.protocol === 'lumix-http' || localState.protocol === 'blackmagic-rest';
  const showSerial = localState.protocol === 'sony-700spp';
  const showUsb = localState.protocol === 'sony-crsdk';
  const showWiznet = localState.protocol === 'sony-700ptp' || localState.protocol === 'sony-700spp';

  return (
    <div className="config-modal-overlay" onClick={onClose}>
      <div className="camera-config" onClick={(e) => e.stopPropagation()}>
        <div className="camera-config__header">
          <h3 className="camera-config__title">
            {isCreate ? 'Add Camera' : 'Camera Configuration'}
          </h3>
          <button className="rcp-btn rcp-btn--sm" onClick={onClose}>✕</button>
        </div>

        <div className="camera-config__section">
          <div className="camera-config__section-title">General</div>

          <div className="camera-config__row">
            <div className="camera-config__field">
              <label className="camera-config__label">Name</label>
              <input
                type="text"
                className="camera-config__input"
                value={localState.name}
                onChange={(e) => setLocalState((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div className="camera-config__field">
              <label className="camera-config__label">Camera #</label>
              <input
                type="number"
                min={1}
                max={99}
                className="camera-config__input"
                value={localState.cameraNumber}
                onChange={(e) => {
                  const cameraNumber = parseInt(e.target.value, 10) || 1;
                  setLocalState((prev) => ({ ...prev, cameraNumber }));
                }}
              />
            </div>
          </div>

          <div className="camera-config__note">
            Type: <strong>{localState.type.toUpperCase()}</strong>
            {selectedProtocolMeta ? ` · ${selectedProtocolMeta.label}` : ''}
          </div>
        </div>

        <div className="camera-config__section">
          <div className="camera-config__section-title">Protocol</div>
          <div className="camera-config__protocol-list">
            {PROTOCOLS.map((proto) => (
              <label
                key={proto.value}
                className={`camera-config__protocol ${localState.protocol === proto.value ? 'camera-config__protocol--selected' : ''}`}
              >
                <input
                  type="radio"
                  name="protocol"
                  value={proto.value}
                  checked={localState.protocol === proto.value}
                  onChange={() => setProtocol(proto.value)}
                />
                <div className="camera-config__protocol-info">
                  <span className="camera-config__protocol-label">{proto.label}</span>
                  <span className="camera-config__protocol-desc">{proto.description}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="camera-config__section">
          <div className="camera-config__section-title">Connection</div>

          {showTcp && (
            <div className="camera-config__row">
              <div className="camera-config__field" style={{ flex: 2 }}>
                <label className="camera-config__label">IP Address / Hostname</label>
                <input
                  type="text"
                  className="camera-config__input"
                  value={localState.settings.host || ''}
                  placeholder={localState.protocol === 'lumix-http' ? '192.168.54.1' : '192.168.1.100'}
                  onChange={(e) => updateSettings('host', e.target.value)}
                />
              </div>
              <div className="camera-config__field">
                <label className="camera-config__label">Port</label>
                <input
                  type="number"
                  className="camera-config__input"
                  value={localState.settings.port || (localState.protocol === 'blackmagic-rest' ? 80 : 7700)}
                  onChange={(e) => updateSettings('port', parseInt(e.target.value, 10) || 0)}
                />
              </div>
            </div>
          )}

          {showSerial && (
            <>
              <div className="camera-config__field">
                <label className="camera-config__label">Serial Port</label>
                <input
                  type="text"
                  className="camera-config__input"
                  value={localState.settings.serialPath || ''}
                  placeholder="COM3 or /dev/ttyUSB0"
                  onChange={(e) => updateSettings('serialPath', e.target.value)}
                />
              </div>
              <div className="camera-config__row">
                <div className="camera-config__field">
                  <label className="camera-config__label">Baud Rate</label>
                  <select
                    className="camera-config__select"
                    value={localState.settings.baudRate || 38400}
                    onChange={(e) => updateSettings('baudRate', parseInt(e.target.value, 10))}
                  >
                    <option value={9600}>9600</option>
                    <option value={19200}>19200</option>
                    <option value={38400}>38400</option>
                    <option value={57600}>57600</option>
                    <option value={115200}>115200</option>
                  </select>
                </div>
                <div className="camera-config__field">
                  <label className="camera-config__label">Parity</label>
                  <select
                    className="camera-config__select"
                    value={localState.settings.parity || 'odd'}
                    onChange={(e) => updateSettings('parity', e.target.value as 'odd' | 'even' | 'none')}
                  >
                    <option value="none">None</option>
                    <option value="odd">Odd</option>
                    <option value="even">Even</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {showUsb && (
            <div className="camera-config__note">
              Sony USB-Kameras (FX3, FX6, FX9, A7 IV, A7S III, A7R V, ZV-E1, A1) werden
              beim Verbinden automatisch per USB erkannt (Vendor-ID 0x054C). Den Scan und
              die Geräteauswahl findest du im Connection-Panel (Tab „Sony USB").
            </div>
          )}

          {showWiznet && (
            <div className="camera-config__field">
              <label className="camera-config__label">WIZ108SR Bridge (optional)</label>
              <select
                className="camera-config__select"
                value={localState.settings.wiznetMac || ''}
                onChange={(e) => updateSettings('wiznetMac', e.target.value)}
              >
                <option value="">Direct connection</option>
              </select>
            </div>
          )}

          {localState.protocol === 'manual' && (
            <div className="camera-config__note">
              Manual mode enabled. This camera is created without live backend connection.
            </div>
          )}
        </div>

        <div className="camera-config__actions">
          {!isCreate && onDelete && (
            <button className="rcp-btn rcp-btn--red" onClick={onDelete}>
              Delete Camera
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="rcp-btn" onClick={onClose}>Cancel</button>
          <button className="rcp-btn rcp-btn--green" onClick={handleSave}>
            {isCreate ? 'Add Camera' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
