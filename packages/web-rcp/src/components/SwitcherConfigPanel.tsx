import React, { useEffect, useState } from 'react';
import type { SwitcherConfig, SwitcherSlot } from '../types.ts';

interface Props {
  switcher: SwitcherSlot;
  ports: string[];
  onListPorts: () => void;
  onSetConfig: (cfg: Partial<SwitcherConfig>) => void;
  onConnect: () => void;
  onRemove: () => void;
}

const DEFAULT_LABELS = ['HDMI-1', 'HDMI-2', 'SDI-1', 'SDI-2', 'SDI-3', 'SDI-4'];

/** Address and route of a VIS-CATC. Save applies and connects. */
export function SwitcherConfigPanel({ switcher, ports, onListPorts, onSetConfig, onConnect, onRemove }: Props) {
  const c = switcher.config;
  const [label, setLabel] = useState(c.label ?? '');
  const [host, setHost] = useState(c.host ?? '');
  const [port, setPort] = useState(String(c.port ?? 80));
  const [path, setPath] = useState<'http' | 'serial'>(c.path ?? 'http');
  const [transport, setTransport] = useState<'none' | 'tcp' | 'port'>(c.serial?.transport ?? 'none');
  const [gwHost, setGwHost] = useState(c.serial?.host ?? '');
  const [gwPort, setGwPort] = useState(String(c.serial?.port ?? 4001));
  const [devicePath, setDevicePath] = useState(c.serial?.devicePath ?? '');
  const [baudRate, setBaudRate] = useState(String(c.serial?.baudRate ?? 9600));
  const [labels, setLabels] = useState<string[]>(c.inputLabels?.length ? c.inputLabels : DEFAULT_LABELS);
  const [pgmWindow, setPgmWindow] = useState(String(c.pgmWindow ?? ''));
  const [removeArmed, setRemoveArmed] = useState(false);

  useEffect(() => {
    if (transport === 'port') onListPorts();
  }, [transport, onListPorts]);

  useEffect(() => {
    if (!removeArmed) return;
    const t = setTimeout(() => setRemoveArmed(false), 4000);
    return () => clearTimeout(t);
  }, [removeArmed]);

  const apply = () => {
    onSetConfig({
      kind: 'vis-catc',
      label: label.trim(),
      host: host.trim(),
      port: Number(port) || 80,
      path,
      serial: {
        transport,
        host: gwHost.trim() || undefined,
        port: Number(gwPort) || 4001,
        devicePath: devicePath || undefined,
        baudRate: Number(baudRate) || 9600,
      },
      inputLabels: labels.map((l) => l.trim() || ''),
      pgmWindow: pgmWindow ? Number(pgmWindow) : undefined,
    });
    setTimeout(onConnect, 100);
  };

  return (
    <div className="panel">
      <h2 className="panel__title">Switcher setup</h2>
      <div className="connection-row">
        <div className="field">
          <label>Name</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Conference room" />
        </div>
      </div>
      <div className="connection-row">
        <div className="field">
          <label>Device IP / hostname</label>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.134" />
        </div>
        <div className="field field--sm">
          <label>Port</label>
          <input value={port} onChange={(e) => setPort(e.target.value)} type="number" />
        </div>
      </div>
      <div className="connection-row">
        <div className="field">
          <label>Switching route</label>
          <select className="select-group__select" value={path} onChange={(e) => setPath(e.target.value as 'http' | 'serial')}>
            <option value="http">Network (POST to the device page)</option>
            <option value="serial">RS-232 (manual §6.3)</option>
          </select>
        </div>
      </div>
      <p className="hint">
        Status is always read over the network. The manual documents switching over RS-232; the device page does the
        same over the network. Freeze exists on the serial route only.
      </p>
      <div className="connection-row">
        <div className="field">
          <label>Serial line</label>
          <select className="select-group__select" value={transport} onChange={(e) => setTransport(e.target.value as 'none' | 'tcp' | 'port')}>
            <option value="none">none</option>
            <option value="tcp">TCP-serial gateway (Moxa, USR-TCP232)</option>
            <option value="port">Port on the bridge computer</option>
          </select>
        </div>
      </div>
      {transport === 'tcp' && (
        <div className="connection-row">
          <div className="field">
            <label>Gateway IP</label>
            <input value={gwHost} onChange={(e) => setGwHost(e.target.value)} placeholder="192.168.1.200" />
          </div>
          <div className="field field--sm">
            <label>Port</label>
            <input value={gwPort} onChange={(e) => setGwPort(e.target.value)} type="number" />
          </div>
        </div>
      )}
      {transport === 'port' && (
        <div className="connection-row">
          <div className="field">
            <label>Serial port</label>
            <div className="serial-port-row">
              <select className="select-group__select" value={devicePath} onChange={(e) => setDevicePath(e.target.value)}>
                <option value="">– select port –</option>
                {ports.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <button className="btn btn--sm" onClick={onListPorts} title="Scan ports">⟳</button>
            </div>
          </div>
          <div className="field field--sm">
            <label>Baud</label>
            <input value={baudRate} onChange={(e) => setBaudRate(e.target.value)} type="number" />
          </div>
        </div>
      )}
      <div className="connection-row">
        {labels.map((l, i) => (
          <div key={i} className="field field--sm">
            <label>Input {i + 1}</label>
            <input value={l} onChange={(e) => setLabels(labels.map((x, j) => (j === i ? e.target.value : x)))} />
          </div>
        ))}
      </div>
      <div className="connection-row">
        <div className="field field--sm">
          <label>Programme window</label>
          <input value={pgmWindow} onChange={(e) => setPgmWindow(e.target.value)} placeholder="auto" type="number" min={1} max={4} />
        </div>
        <div className="field">
          <span className="hint">Empty: the largest window of the current layout is the programme.</span>
        </div>
      </div>
      <div className="connection-actions row">
        <button className="btn btn--primary" onClick={apply}>Save and connect</button>
        <span style={{ flex: 1 }} />
        <button
          className={`btn btn--sm ${removeArmed ? 'btn--danger' : ''}`}
          onClick={() => { if (removeArmed) onRemove(); else setRemoveArmed(true); }}
        >
          {removeArmed ? 'Remove — click again' : 'Remove switcher'}
        </button>
      </div>
    </div>
  );
}
