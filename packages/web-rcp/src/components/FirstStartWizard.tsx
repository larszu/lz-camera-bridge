import React, { useState } from 'react';
import type { BridgeConfig } from '../types.ts';

const WIZARD_KEY = 'scb.wizardDone';

export function isWizardDone(): boolean {
  return localStorage.getItem(WIZARD_KEY) === '1';
}

export function markWizardDone(): void {
  localStorage.setItem(WIZARD_KEY, '1');
}

type CameraType = 'sony-tcp' | 'sony-serial' | 'sony-usb' | 'lumix';

interface Props {
  onComplete: (config: Partial<BridgeConfig>) => void;
}

const STEPS = ['Willkommen', 'Kameratyp', 'Verbindung', 'Fertig'];

export function FirstStartWizard({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [cameraType, setCameraType] = useState<CameraType>('sony-tcp');

  // Sony TCP
  const [tcpHost, setTcpHost] = useState('192.168.1.10');
  const [tcpPort, setTcpPort] = useState(7700);

  // Sony Serial
  const [serialPath, setSerialPath] = useState('COM1');
  const [baudRate, setBaudRate] = useState(38400);

  // Lumix
  const [lumixHost, setLumixHost] = useState('192.168.54.1');
  const [lumixPort, setLumixPort] = useState(80);

  function buildConfig(): Partial<BridgeConfig> {
    if (cameraType === 'sony-tcp') {
      return { connectionMode: 'tcp', tcpHost, tcpPort };
    }
    if (cameraType === 'sony-serial') {
      return { connectionMode: 'serial', serialPath, baudRate };
    }
    if (cameraType === 'sony-usb') {
      return { connectionMode: 'sony-usb' };
    }
    return { connectionMode: 'lumix-http', lumixHost, lumixPort };
  }

  function handleFinish() {
    markWizardDone();
    onComplete(buildConfig());
  }

  return (
    <div className="wizard-overlay">
      <div className="wizard-modal">
        {/* Header */}
        <div className="wizard-header">
          <div className="wizard-logo">
            <span className="wizard-logo-icon">◎</span>
            <span className="wizard-logo-text">Camera Bridge</span>
          </div>
          <div className="wizard-steps">
            {STEPS.map((s, i) => (
              <div
                key={s}
                className={`wizard-step-dot ${i === step ? 'active' : i < step ? 'done' : ''}`}
                title={s}
              >
                {i < step ? '✓' : i + 1}
              </div>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="wizard-body">
          {step === 0 && <StepWelcome />}
          {step === 1 && (
            <StepCameraType value={cameraType} onChange={setCameraType} />
          )}
          {step === 2 && (
            <StepConnection
              cameraType={cameraType}
              tcpHost={tcpHost} setTcpHost={setTcpHost}
              tcpPort={tcpPort} setTcpPort={setTcpPort}
              serialPath={serialPath} setSerialPath={setSerialPath}
              baudRate={baudRate} setBaudRate={setBaudRate}
              lumixHost={lumixHost} setLumixHost={setLumixHost}
              lumixPort={lumixPort} setLumixPort={setLumixPort}
            />
          )}
          {step === 3 && <StepDone cameraType={cameraType} config={buildConfig()} />}
        </div>

        {/* Footer */}
        <div className="wizard-footer">
          {step > 0 && (
            <button className="wizard-btn wizard-btn--secondary" onClick={() => setStep(s => s - 1)}>
              Zurück
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step < STEPS.length - 1 ? (
            <button className="wizard-btn wizard-btn--primary" onClick={() => setStep(s => s + 1)}>
              {step === 0 ? 'Einrichten' : 'Weiter'}
            </button>
          ) : (
            <button className="wizard-btn wizard-btn--success" onClick={handleFinish}>
              Starten
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Step 0: Welcome ─────────────────────────────────────────────────── */
function StepWelcome() {
  return (
    <div className="wizard-step">
      <h2 className="wizard-step__title">Willkommen</h2>
      <p className="wizard-step__desc">
        <strong>Camera Bridge</strong> verbindet Sony CCU-Kameras (BRC, HXC, HDC…)
        und Panasonic Lumix Kameras mit Bitfocus Companion und steuert sie über
        einen professionellen Software-RCP.
      </p>
      <div className="wizard-feature-list">
        <div className="wizard-feature">
          <span className="wizard-feature__icon">🎥</span>
          <div>
            <div className="wizard-feature__name">Sony 700PTP / RS-422</div>
            <div className="wizard-feature__desc">Iris, Master Black, Gain, Gamma, WB, Tally</div>
          </div>
        </div>
        <div className="wizard-feature">
          <span className="wizard-feature__icon">📷</span>
          <div>
            <div className="wizard-feature__name">Panasonic Lumix (WiFi/LAN)</div>
            <div className="wizard-feature__desc">S1, S5, GH5, GH6, BGH1 – HTTP CGI Protokoll</div>
          </div>
        </div>
        <div className="wizard-feature">
          <span className="wizard-feature__icon">🎛️</span>
          <div>
            <div className="wizard-feature__name">Bitfocus Companion</div>
            <div className="wizard-feature__desc">HTTP + WebSocket API für Streamdecks</div>
          </div>
        </div>
      </div>
      <p className="wizard-step__hint">
        Dieser Assistent hilft dir, die erste Kamera einzurichten. Du kannst die
        Einstellungen jederzeit im Connection-Panel ändern.
      </p>
    </div>
  );
}

/* ── Step 1: Camera Type ─────────────────────────────────────────────── */
function StepCameraType({ value, onChange }: { value: CameraType; onChange: (v: CameraType) => void }) {
  const options: { id: CameraType; label: string; sub: string; badge?: string }[] = [
    { id: 'sony-tcp', label: 'Sony CCU – TCP / Netzwerk', sub: 'WIZ108SR Adapter oder direkte Netzwerkverbindung (700PTP)', badge: 'empfohlen' },
    { id: 'sony-serial', label: 'Sony CCU – RS-422 Seriell', sub: 'Direkte 8-Pin RS-422 Verbindung via COM-Port' },
    { id: 'sony-usb', label: 'Sony Alpha / Cinema – USB', sub: 'FX3, FX6, FX9, A7 IV, A7S III, A1 … via Camera Remote SDK' },
    { id: 'lumix', label: 'Panasonic Lumix – WiFi / LAN', sub: 'HTTP CGI Protokoll (S1, S5, GH5, GH6, BGH1, BS1H…)' },
  ];

  return (
    <div className="wizard-step">
      <h2 className="wizard-step__title">Kameratyp wählen</h2>
      <p className="wizard-step__desc">Welche Kamera möchtest du als erstes einrichten?</p>
      <div className="wizard-camera-list">
        {options.map(opt => (
          <button
            key={opt.id}
            className={`wizard-camera-card ${value === opt.id ? 'selected' : ''}`}
            onClick={() => onChange(opt.id)}
          >
            <div className="wizard-camera-card__radio">
              <div className={`wizard-radio ${value === opt.id ? 'active' : ''}`} />
            </div>
            <div className="wizard-camera-card__body">
              <div className="wizard-camera-card__label">
                {opt.label}
                {opt.badge && <span className="wizard-badge">{opt.badge}</span>}
              </div>
              <div className="wizard-camera-card__sub">{opt.sub}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Step 2: Connection Details ──────────────────────────────────────── */
interface StepConnectionProps {
  cameraType: CameraType;
  tcpHost: string; setTcpHost: (v: string) => void;
  tcpPort: number; setTcpPort: (v: number) => void;
  serialPath: string; setSerialPath: (v: string) => void;
  baudRate: number; setBaudRate: (v: number) => void;
  lumixHost: string; setLumixHost: (v: string) => void;
  lumixPort: number; setLumixPort: (v: number) => void;
}

function StepConnection(p: StepConnectionProps) {
  return (
    <div className="wizard-step">
      <h2 className="wizard-step__title">Verbindungsdetails</h2>

      {p.cameraType === 'sony-tcp' && (
        <>
          <p className="wizard-step__desc">
            Gib die IP-Adresse und den Port des Sony CCU Adapters ein (z.B. WIZ108SR).
          </p>
          <div className="wizard-form">
            <label className="wizard-label">
              IP-Adresse / Hostname
              <input
                className="wizard-input"
                value={p.tcpHost}
                onChange={e => p.setTcpHost(e.target.value)}
                placeholder="192.168.1.10"
              />
            </label>
            <label className="wizard-label wizard-label--small">
              Port
              <input
                className="wizard-input"
                type="number"
                value={p.tcpPort}
                onChange={e => p.setTcpPort(Number(e.target.value))}
                placeholder="7700"
              />
            </label>
          </div>
          <p className="wizard-step__hint">
            Standard-Port für Sony 700PTP ist <code>7700</code>. Der WIZ108SR Adapter kann
            automatisch über den Discover-Button gefunden werden.
          </p>
        </>
      )}

      {p.cameraType === 'sony-serial' && (
        <>
          <p className="wizard-step__desc">
            Wähle den COM-Port für die RS-422 Verbindung.
          </p>
          <div className="wizard-form">
            <label className="wizard-label">
              COM-Port
              <input
                className="wizard-input"
                value={p.serialPath}
                onChange={e => p.setSerialPath(e.target.value)}
                placeholder="COM3"
              />
            </label>
            <label className="wizard-label wizard-label--small">
              Baudrate
              <select
                className="wizard-input"
                value={p.baudRate}
                onChange={e => p.setBaudRate(Number(e.target.value))}
              >
                {[9600, 19200, 38400, 57600, 115200].map(b => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="wizard-step__hint">
            Sony CCU RS-422 läuft standardmäßig mit <code>38400 Baud</code>.
          </p>
        </>
      )}

      {p.cameraType === 'sony-usb' && (
        <>
          <p className="wizard-step__desc">
            Verbinde die Kamera (z.B. FX3) per USB-C mit diesem Rechner und stelle sie
            auf <strong>„PC Remote"</strong> (USB-Steuerung).
          </p>
          <p className="wizard-step__hint">
            Die Kamera wird beim Verbinden automatisch per USB erkannt (Sony Vendor‑ID
            0x054C). Im Connection‑Panel kannst du das gefundene Gerät auswählen und
            erneut scannen. Für die volle Steuerung wird auf dem Zielrechner das
            optionale Modul <code>usb</code> sowie das Sony Camera Remote SDK benötigt.
          </p>
        </>
      )}

      {p.cameraType === 'lumix' && (
        <>
          <p className="wizard-step__desc">
            Gib die IP-Adresse der Lumix Kamera ein. Im Direct WiFi Modus ist die
            Standard-IP <code>192.168.54.1</code>.
          </p>
          <div className="wizard-form">
            <label className="wizard-label">
              Kamera IP-Adresse
              <input
                className="wizard-input"
                value={p.lumixHost}
                onChange={e => p.setLumixHost(e.target.value)}
                placeholder="192.168.54.1"
              />
            </label>
            <label className="wizard-label wizard-label--small">
              Port
              <input
                className="wizard-input"
                type="number"
                value={p.lumixPort}
                onChange={e => p.setLumixPort(Number(e.target.value))}
                placeholder="80"
              />
            </label>
          </div>
          <p className="wizard-step__hint">
            Aktiviere auf der Lumix den Modus <strong>„Remote Shooting"</strong> unter
            Menü → WiFi → PC Remote. Verbinde diesen PC mit dem WLAN der Kamera.
          </p>
        </>
      )}
    </div>
  );
}

/* ── Step 3: Done ────────────────────────────────────────────────────── */
function StepDone({ cameraType, config }: { cameraType: CameraType; config: Partial<BridgeConfig> }) {
  const label =
    cameraType === 'sony-tcp' ? 'Sony CCU via TCP'
    : cameraType === 'sony-serial' ? 'Sony CCU via RS-422'
    : cameraType === 'sony-usb' ? 'Sony Alpha/Cinema via USB'
    : 'Panasonic Lumix WiFi';

  return (
    <div className="wizard-step wizard-step--done">
      <div className="wizard-done-icon">✓</div>
      <h2 className="wizard-step__title">Alles bereit!</h2>
      <p className="wizard-step__desc">
        Die Verbindung wurde konfiguriert. Klicke auf <strong>Starten</strong> um die
        App zu öffnen und die Kamera zu verbinden.
      </p>
      <div className="wizard-summary">
        <div className="wizard-summary__row">
          <span className="wizard-summary__key">Kameratyp</span>
          <span className="wizard-summary__val">{label}</span>
        </div>
        {config.tcpHost && (
          <div className="wizard-summary__row">
            <span className="wizard-summary__key">Adresse</span>
            <span className="wizard-summary__val">{config.tcpHost}:{config.tcpPort}</span>
          </div>
        )}
        {config.serialPath && (
          <div className="wizard-summary__row">
            <span className="wizard-summary__key">COM-Port</span>
            <span className="wizard-summary__val">{config.serialPath} @ {config.baudRate}</span>
          </div>
        )}
        {config.lumixHost && (
          <div className="wizard-summary__row">
            <span className="wizard-summary__key">Adresse</span>
            <span className="wizard-summary__val">{config.lumixHost}:{config.lumixPort}</span>
          </div>
        )}
      </div>
      <p className="wizard-step__hint">
        Im Connection-Panel kannst du die Kamera mit einem Klick verbinden und
        weitere Kameras hinzufügen.
      </p>
    </div>
  );
}
