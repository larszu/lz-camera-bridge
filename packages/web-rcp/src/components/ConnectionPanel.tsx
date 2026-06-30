import React, { useState, useEffect } from 'react';
import type { BridgeConfig, SonyUsbDevice } from '../types.ts';

type ConnMode = 'tcp' | 'serial' | 'lumix-http' | 'sony-usb';

interface Props {
  config: BridgeConfig;
  ports: string[];
  sonyUsbDevices: SonyUsbDevice[];
  onSetConfig: (cfg: Partial<BridgeConfig>) => void;
  onListPorts: () => void;
  onDiscoverSonyUsb: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  cameraConnected: boolean;
  wsStatus: string;
}

export function ConnectionPanel({ config, ports, sonyUsbDevices, onSetConfig, onListPorts, onDiscoverSonyUsb, onConnect, onDisconnect, cameraConnected, wsStatus }: Props) {
  const [mode, setMode] = useState<ConnMode>(config.connectionMode ?? 'tcp');
  const [host, setHost] = useState(config.tcpHost ?? '192.168.1.10');
  const [port, setPort] = useState(String(config.tcpPort ?? 7700));
  const [serialPath, setSerialPath] = useState(config.serialPath ?? '');
  const [baudRate, setBaudRate] = useState(String(config.baudRate ?? 38400));
  const [ccuId, setCcuId] = useState(String(config.ccuId ?? 0));
  const [lumixHost, setLumixHost] = useState(config.lumixHost ?? '192.168.54.1');
  const [lumixPort, setLumixPort] = useState(String(config.lumixPort ?? 80));
  const [usbDeviceId, setUsbDeviceId] = useState(config.usbDeviceId ?? '');

  useEffect(() => {
    if (mode === 'serial') onListPorts();
    if (mode === 'sony-usb') onDiscoverSonyUsb();
  }, [mode, onListPorts, onDiscoverSonyUsb]);

  useEffect(() => {
    if (config.connectionMode) setMode(config.connectionMode);
    if (config.tcpHost) setHost(config.tcpHost);
    if (config.tcpPort) setPort(String(config.tcpPort));
    if (config.serialPath) setSerialPath(config.serialPath);
    if (config.baudRate) setBaudRate(String(config.baudRate));
    if (config.ccuId !== undefined) setCcuId(String(config.ccuId));
    if (config.lumixHost) setLumixHost(config.lumixHost);
    if (config.lumixPort) setLumixPort(String(config.lumixPort));
    if (config.usbDeviceId) setUsbDeviceId(config.usbDeviceId);
  }, [config]);

  // Auto-select the first discovered camera when none is chosen yet.
  useEffect(() => {
    if (mode === 'sony-usb' && !usbDeviceId && sonyUsbDevices.length > 0) {
      setUsbDeviceId(sonyUsbDevices[0].id);
    }
  }, [sonyUsbDevices, mode, usbDeviceId]);

  const applyAndConnect = () => {
    const cfg: Partial<BridgeConfig> = { connectionMode: mode };
    if (mode === 'tcp') {
      cfg.tcpHost = host;
      cfg.tcpPort = Number(port);
      cfg.ccuId = Number(ccuId);
    } else if (mode === 'lumix-http') {
      cfg.lumixHost = lumixHost;
      cfg.lumixPort = Number(lumixPort);
    } else if (mode === 'sony-usb') {
      cfg.usbDeviceId = usbDeviceId;
      cfg.usbDeviceModel = sonyUsbDevices.find((d) => d.id === usbDeviceId)?.model;
      cfg.ccuId = Number(ccuId);
    } else {
      cfg.serialPath = serialPath;
      cfg.baudRate = Number(baudRate);
      cfg.ccuId = Number(ccuId);
    }
    onSetConfig(cfg);
    setTimeout(onConnect, 100);
  };

  return (
    <div className="panel panel--connection">
      <h2 className="panel__title">Connection</h2>

      <div className="mode-tabs">
        <button className={`mode-tab ${mode === 'tcp' ? 'mode-tab--active' : ''}`} onClick={() => setMode('tcp')}>
          TCP / Netzwerk (Sony)
        </button>
        <button className={`mode-tab ${mode === 'serial' ? 'mode-tab--active' : ''}`} onClick={() => setMode('serial')}>
          8-Pin RS-422 Seriell
        </button>
        <button className={`mode-tab ${mode === 'sony-usb' ? 'mode-tab--active' : ''}`} onClick={() => setMode('sony-usb')}>
          Sony USB (FX3/FX6/A7)
        </button>
        <button className={`mode-tab ${mode === 'lumix-http' ? 'mode-tab--active' : ''}`} onClick={() => setMode('lumix-http')}>
          Lumix (WiFi/LAN)
        </button>
      </div>

      {mode === 'tcp' && (
        <div className="connection-row">
          <div className="field">
            <label>CCU / RP700 IP</label>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" />
          </div>
          <div className="field field--sm">
            <label>Port</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="7700" type="number" />
          </div>
          <div className="field field--sm">
            <label>CCU ID</label>
            <input value={ccuId} onChange={(e) => setCcuId(e.target.value)} placeholder="0" type="number" />
          </div>
        </div>
      )}

      {mode === 'serial' && (
        <div className="connection-row">
          <div className="field">
            <label>Serial Port</label>
            <div className="serial-port-row">
              <select value={serialPath} onChange={(e) => setSerialPath(e.target.value)} className="select-group__select">
                <option value="">� Port w�hlen �</option>
                {ports.map((p) => (<option key={p} value={p}>{p}</option>))}
              </select>
              <button className="btn btn--sm" onClick={onListPorts} title="Ports neu laden">?</button>
            </div>
          </div>
          <div className="field field--sm">
            <label>Baud Rate</label>
            <select value={baudRate} onChange={(e) => setBaudRate(e.target.value)} className="select-group__select">
              <option value="38400">38400</option>
              <option value="19200">19200</option>
              <option value="9600">9600</option>
            </select>
          </div>
          <div className="field field--sm">
            <label>CCU ID</label>
            <input value={ccuId} onChange={(e) => setCcuId(e.target.value)} placeholder="0" type="number" />
          </div>
        </div>
      )}

      {mode === 'sony-usb' && (
        <div className="connection-row">
          <div className="field">
            <label>Kamera (USB)</label>
            <div className="serial-port-row">
              <select
                value={usbDeviceId}
                onChange={(e) => setUsbDeviceId(e.target.value)}
                className="select-group__select"
              >
                {sonyUsbDevices.length === 0 && <option value="">– keine Kamera gefunden –</option>}
                {sonyUsbDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.model}{d.serialNumber ? ` (${d.serialNumber})` : ''}
                  </option>
                ))}
              </select>
              <button className="btn btn--sm" onClick={onDiscoverSonyUsb} title="USB neu scannen">⟳</button>
            </div>
          </div>
          <div className="field field--sm">
            <label>Kamera-Nr.</label>
            <input value={ccuId} onChange={(e) => setCcuId(e.target.value)} placeholder="0" type="number" />
          </div>
          <div className="field" style={{ alignSelf: 'flex-end', paddingBottom: '0.25rem' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
              Kamera in „PC Remote" (USB-Steuerung) versetzen
            </span>
          </div>
        </div>
      )}

      {mode === 'lumix-http' && (
        <div className="connection-row">
          <div className="field">
            <label>Kamera IP (WiFi/LAN)</label>
            <input value={lumixHost} onChange={(e) => setLumixHost(e.target.value)} placeholder="192.168.54.1" />
          </div>
          <div className="field field--sm">
            <label>Port</label>
            <input value={lumixPort} onChange={(e) => setLumixPort(e.target.value)} placeholder="80" type="number" />
          </div>
          <div className="field" style={{ alignSelf: 'flex-end', paddingBottom: '0.25rem' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
              S1, S1R, S1H, S5, S5II, GH5, GH6, BGH1, BS1H
            </span>
          </div>
        </div>
      )}

      <div className="connection-actions">
        {cameraConnected ? (
          <button className="btn btn--danger" onClick={onDisconnect}>Disconnect</button>
        ) : (
          <button className="btn btn--primary" onClick={applyAndConnect}>Connect</button>
        )}
      </div>

      <div className="status-row">
        <span className={`status-dot status-dot--${wsStatus === 'connected' ? 'ok' : 'err'}`} />
        <span>Bridge: {wsStatus}</span>
        <span className={`status-dot status-dot--${cameraConnected ? 'ok' : 'err'} ml-16`} />
        <span>Kamera: {cameraConnected ? 'Verbunden' : 'Offline'}</span>
        {mode === 'serial' && serialPath && (
          <span className="ml-16" style={{ color: 'var(--text-muted)' }}>({serialPath})</span>
        )}
        {mode === 'lumix-http' && lumixHost && (
          <span className="ml-16" style={{ color: 'var(--text-muted)' }}>({lumixHost})</span>
        )}
      </div>
    </div>
  );
}
