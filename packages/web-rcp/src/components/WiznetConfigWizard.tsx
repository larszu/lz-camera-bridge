import React, { useState, useEffect } from 'react';
import type { WiznetDevice } from '../types.ts';

interface WiznetDeviceConfig {
  ip: string;
  subnet: string;
  gateway: string;
  port: number;
  mode: 'server' | 'client';
  peer_ip: string;
  peer_port: number;
  baud: number;
  parity: 'odd' | 'even' | 'none';
  dhcp: boolean;
}

interface Props {
  device: WiznetDevice | null;
  onClose: () => void;
  onConfigure: (deviceIp: string, config: Record<string, unknown>) => void;
}

type WizardStep = 'mode' | 'network' | 'serial' | 'peer' | 'confirm';

const STEPS: WizardStep[] = ['mode', 'network', 'serial', 'peer', 'confirm'];

const STEP_TITLES: Record<WizardStep, string> = {
  mode: 'Mode',
  network: 'Network',
  serial: 'Serial port',
  peer: 'Peer',
  confirm: 'Confirm',
};

export function WiznetConfigWizard({ device, onClose, onConfigure }: Props) {
  const [step, setStep] = useState<WizardStep>('mode');
  const [config, setConfig] = useState<WiznetDeviceConfig>({
    ip: device?.ip ?? '192.168.1.100',
    subnet: '255.255.255.0',
    gateway: '192.168.1.1',
    port: device?.port ?? 7700,
    mode: device?.mode ?? 'server',
    peer_ip: '192.168.1.10',
    peer_port: 7700,
    baud: device?.baud ?? 38400,
    parity: device?.parity ?? 'odd',
    dhcp: false,
  });

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (device) {
      setConfig((prev) => ({
        ...prev,
        ip: device.ip,
        port: device.port,
        mode: device.mode,
        baud: device.baud,
        parity: device.parity,
      }));
    }
  }, [device]);

  if (!device) return null;

  const stepIndex = STEPS.indexOf(step);

  const goNext = () => {
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next);
  };

  const goBack = () => {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev);
  };

  const handleSubmit = () => {
    setSubmitting(true);
    onConfigure(device.ip, config as unknown as Record<string, unknown>);
    setTimeout(() => {
      setSubmitting(false);
      onClose();
    }, 1500);
  };

  const updateConfig = <K extends keyof WiznetDeviceConfig>(key: K, value: WiznetDeviceConfig[K]) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="wizard-overlay" onClick={onClose}>
      <div className="wizard" onClick={(e) => e.stopPropagation()}>
        <div className="wizard__header">
          <h2>WIZ108SR konfigurieren</h2>
          <span className="wizard__device">{device.ident} ({device.mac})</span>
        </div>

        {/* Progress indicator */}
        <div className="wizard__progress">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`wizard__step ${i === stepIndex ? 'wizard__step--active' : ''} ${i < stepIndex ? 'wizard__step--done' : ''}`}
            >
              <div className="wizard__step-dot">{i < stepIndex ? '✓' : i + 1}</div>
              <span className="wizard__step-label">{STEP_TITLES[s]}</span>
            </div>
          ))}
        </div>

        <div className="wizard__content">
          {step === 'mode' && (
            <div className="wizard__section">
              <h3>Choose the operating mode</h3>
              <p className="wizard__hint">
                <strong>Camera (server):</strong> waits for incoming connections. Use this on the camera/CCU side.<br />
                <strong>RCP (client):</strong> actively connects to a peer. Use this at the panel/RCP.
              </p>
              <div className="wizard__mode-select">
                <button
                  className={`wizard__mode-btn ${config.mode === 'server' ? 'wizard__mode-btn--active' : ''}`}
                  onClick={() => updateConfig('mode', 'server')}
                >
                  <span className="wizard__mode-icon">📹</span>
                  <span className="wizard__mode-title">Camera (server)</span>
                  <span className="wizard__mode-desc">Receives commands</span>
                </button>
                <button
                  className={`wizard__mode-btn ${config.mode === 'client' ? 'wizard__mode-btn--active' : ''}`}
                  onClick={() => updateConfig('mode', 'client')}
                >
                  <span className="wizard__mode-icon">🎛️</span>
                  <span className="wizard__mode-title">RCP (Client)</span>
                  <span className="wizard__mode-desc">Sendet Befehle</span>
                </button>
              </div>
            </div>
          )}

          {step === 'network' && (
            <div className="wizard__section">
              <h3>Network settings</h3>
              <label className="wizard__field">
                <input
                  type="checkbox"
                  checked={config.dhcp}
                  onChange={(e) => updateConfig('dhcp', e.target.checked)}
                />
                <span>Use DHCP (automatic IP)</span>
              </label>
              {!config.dhcp && (
                <>
                  <label className="wizard__field">
                    <span>IP-Adresse</span>
                    <input
                      type="text"
                      value={config.ip}
                      onChange={(e) => updateConfig('ip', e.target.value)}
                      placeholder="192.168.1.100"
                    />
                  </label>
                  <label className="wizard__field">
                    <span>Subnetzmaske</span>
                    <input
                      type="text"
                      value={config.subnet}
                      onChange={(e) => updateConfig('subnet', e.target.value)}
                      placeholder="255.255.255.0"
                    />
                  </label>
                  <label className="wizard__field">
                    <span>Gateway</span>
                    <input
                      type="text"
                      value={config.gateway}
                      onChange={(e) => updateConfig('gateway', e.target.value)}
                      placeholder="192.168.1.1"
                    />
                  </label>
                </>
              )}
              <label className="wizard__field">
                <span>TCP Port</span>
                <input
                  type="number"
                  value={config.port}
                  onChange={(e) => updateConfig('port', parseInt(e.target.value, 10) || 7700)}
                  min={1}
                  max={65535}
                />
              </label>
            </div>
          )}

          {step === 'serial' && (
            <div className="wizard__section">
              <h3>Serial port (RS-422)</h3>
              <p className="wizard__hint">
                Sony 700PTP/SPP uses <strong>38400 baud, 8 data bits, 1 stop bit, odd parity</strong>.
              </p>
              <label className="wizard__field">
                <span>Baud rate</span>
                <select
                  value={config.baud}
                  onChange={(e) => updateConfig('baud', parseInt(e.target.value, 10))}
                >
                  <option value={38400}>38400 (default)</option>
                  <option value={19200}>19200</option>
                  <option value={9600}>9600</option>
                </select>
              </label>
              <label className="wizard__field">
                <span>Parity</span>
                <select
                  value={config.parity}
                  onChange={(e) => updateConfig('parity', e.target.value as 'odd' | 'even' | 'none')}
                >
                  <option value="odd">Odd (default for Sony)</option>
                  <option value="even">Even</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>
          )}

          {step === 'peer' && (
            <div className="wizard__section">
              <h3>Configure the peer</h3>
              {config.mode === 'client' ? (
                <>
                  <p className="wizard__hint">
                    In client mode this adapter actively connects to the peer you give it (camera/CCU).
                  </p>
                  <label className="wizard__field">
                    <span>Target IP (camera/CCU)</span>
                    <input
                      type="text"
                      value={config.peer_ip}
                      onChange={(e) => updateConfig('peer_ip', e.target.value)}
                      placeholder="192.168.1.10"
                    />
                  </label>
                  <label className="wizard__field">
                    <span>Ziel-Port</span>
                    <input
                      type="number"
                      value={config.peer_port}
                      onChange={(e) => updateConfig('peer_port', parseInt(e.target.value, 10) || 7700)}
                      min={1}
                      max={65535}
                    />
                  </label>
                </>
              ) : (
                <p className="wizard__hint">
                  In server mode this adapter waits for incoming connections on port <strong>{config.port}</strong>.
                  No peer needed — clients (RCP/web dashboard) connect to it.
                </p>
              )}
            </div>
          )}

          {step === 'confirm' && (
            <div className="wizard__section">
              <h3>Confirm the configuration</h3>
              <div className="wizard__summary">
                <div className="wizard__summary-row">
                  <span>Mode:</span>
                  <strong>{config.mode === 'server' ? 'Camera (server)' : 'RCP (client)'}</strong>
                </div>
                <div className="wizard__summary-row">
                  <span>IP address:</span>
                  <strong>{config.dhcp ? 'DHCP (automatic)' : config.ip}</strong>
                </div>
                {!config.dhcp && (
                  <>
                    <div className="wizard__summary-row">
                      <span>Subnet:</span>
                      <strong>{config.subnet}</strong>
                    </div>
                    <div className="wizard__summary-row">
                      <span>Gateway:</span>
                      <strong>{config.gateway}</strong>
                    </div>
                  </>
                )}
                <div className="wizard__summary-row">
                  <span>Port:</span>
                  <strong>{config.port}</strong>
                </div>
                <div className="wizard__summary-row">
                  <span>Seriell:</span>
                  <strong>{config.baud} Baud, Parity: {config.parity}</strong>
                </div>
                {config.mode === 'client' && (
                  <div className="wizard__summary-row">
                    <span>Peer:</span>
                    <strong>{config.peer_ip}:{config.peer_port}</strong>
                  </div>
                )}
              </div>
              <p className="wizard__hint">
                After saving, the adapter restarts and takes on the new configuration.
              </p>
            </div>
          )}
        </div>

        <div className="wizard__footer">
          <button className="btn" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <div className="wizard__nav">
            {stepIndex > 0 && (
              <button className="btn" onClick={goBack} disabled={submitting}>
                ← Back
              </button>
            )}
            {step !== 'confirm' ? (
              <button className="btn btn--primary" onClick={goNext}>
                Next →
              </button>
            ) : (
              <button className="btn btn--primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : 'Save configuration'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
