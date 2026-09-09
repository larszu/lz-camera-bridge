import React, { useState } from 'react';
import type { WiznetDevice } from '../types.ts';
import { WiznetConfigWizard } from './WiznetConfigWizard.tsx';

interface Props {
  devices: WiznetDevice[];
  onDiscover: () => void;
  onConfigure: (deviceIp: string, config: Record<string, unknown>) => void;
  onSelectDevice: (device: WiznetDevice) => void;
}

export function WiznetPanel({ devices, onDiscover, onConfigure, onSelectDevice }: Props) {
  const [configuring, setConfiguring] = useState<WiznetDevice | null>(null);

  return (
    <div className="panel panel--wiznet">
      <div className="panel__header">
        <h2 className="panel__title">WIZ108SR Adapter</h2>
        <button className="btn btn--sm" onClick={onDiscover} title="Netzwerk scannen">
          Scan
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="wiznet-empty">
          No devices found. Click <strong>Scan</strong> to search the network.
        </div>
      ) : (
        <div className="wiznet-list">
          {devices.map((d) => (
            <div key={d.mac} className="wiznet-card">
              <div className="wiznet-card__header">
                <span className="wiznet-card__ident">{d.ident}</span>
                <span className="wiznet-card__fw">v{d.fw}</span>
              </div>
              <div className="wiznet-card__info">
                <span><strong>IP:</strong> {d.ip}:{d.port}</span>
                <span><strong>MAC:</strong> {d.mac}</span>
                <span><strong>Mode:</strong> {d.mode === 'server' ? 'Camera (server)' : 'RCP (client)'}</span>
                <span><strong>Seriell:</strong> {d.baud} Baud, Parity: {d.parity}</span>
              </div>
              <div className="wiznet-card__actions">
                <button
                  className="btn btn--sm"
                  onClick={() => setConfiguring(d)}
                  title="Configure device"
                >
                  Einstellungen
                </button>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={() => onSelectDevice(d)}
                  title="Use this device as the TCP target"
                >
                  Verbinden
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {configuring && (
        <WiznetConfigWizard
          device={configuring}
          onClose={() => setConfiguring(null)}
          onConfigure={(ip, cfg) => {
            onConfigure(ip, cfg);
            setConfiguring(null);
          }}
        />
      )}
    </div>
  );
}
