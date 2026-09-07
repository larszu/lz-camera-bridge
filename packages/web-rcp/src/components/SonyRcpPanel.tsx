import React, { useEffect, useState } from 'react';
import { TallyState } from './TallyBar.tsx';
import { RotaryKnob } from './RotaryKnob.tsx';
import type { CameraCapabilities, CameraState } from '../types.ts';
import {
  NO_READBACK_NOTE,
  UNCONFIRMED_CLASS,
  UNCONFIRMED_NOTE,
  freshnessOf,
  freshnessProps,
  istUnbestaetigt,
  type Confirmations,
  type FreshnessLimits,
  type Origins,
} from '../origin.ts';

interface SonyRcpPanelProps {
  state: CameraState;
  /**
   * BEDARF 46 — woher jeder Wert stammt. Ohne Eintrag: es gibt ihn nicht,
   * und das Pult zeigt „--" statt einer markierten Zahl.
   */
  origins?: Origins;
  /** Dieser Weg liest gar nichts zurueck. Kommt fertig von der Bruecke. */
  neverReadsBack?: boolean;
  /**
   * BEDARF 102 — wann jedes Feld zuletzt bestaetigt wurde, und in welchem
   * Takt dieser Weg ueberhaupt bestaetigt. Beides kommt fertig von der
   * Bruecke; das Pult rechnet das Urteil nicht selbst aus.
   */
  confirmations?: Confirmations;
  freshnessLimits?: FreshnessLimits | null;
  tally: TallyState;
  cameraId?: number;
  disabled?: boolean;
  capabilities?: CameraCapabilities;
  onCommand: (cmd: string, params: Record<string, unknown>) => void;
  onSetTally: (tally: Partial<TallyState>) => void;
}

// Gain options
const GAIN_VALUES = ['0dB', '+3dB', '+6dB', '+9dB', '+12dB', '+15dB', '+18dB'];
// ND options
const ND_VALUES = ['1', '2', '3', '4'];
// CC options  
const CC_VALUES = ['A', 'B', 'C', 'D'];

/** Value box with color border */
function ValueBox({ value, color, label, onChange, disabled }: {
  value: number;
  color: 'red' | 'green' | 'blue';
  label?: string;
  onChange?: (delta: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`rcp-value-box rcp-value-box--${color} ${disabled ? 'rcp-value-box--disabled' : ''}`}>
      <span className="rcp-value-box__value">{value}</span>
      {label && <span className="rcp-value-box__label">{label}</span>}
      {onChange && (
        <div className="rcp-value-box__arrows">
          <button onClick={() => onChange(1)} disabled={disabled}>▲</button>
          <button onClick={() => onChange(-1)} disabled={disabled}>▼</button>
        </div>
      )}
    </div>
  );
}

/** Selector with up/down arrows */
function Selector({ value, label, onChange, disabled, unconfirmed }: {
  value: string;
  label: string;
  onChange?: (delta: number) => void;
  disabled?: boolean;
  /** BEDARF 46 — gesendet, aber nie zurueckgelesen. */
  unconfirmed?: boolean;
}) {
  return (
    <div className={`rcp-selector ${disabled ? 'rcp-selector--disabled' : ''}`}>
      <div
        className={`rcp-selector__display${unconfirmed ? ` ${UNCONFIRMED_CLASS}` : ''}`}
        title={unconfirmed ? UNCONFIRMED_NOTE : undefined}
      >
        {value}
      </div>
      {onChange && (
        <div className="rcp-selector__arrows">
          <button onClick={() => onChange(1)} disabled={disabled}>▲</button>
          <button onClick={() => onChange(-1)} disabled={disabled}>▼</button>
        </div>
      )}
      <div className="rcp-selector__label">{label}</div>
    </div>
  );
}

/** RCP Button */
function RcpButton({ label, active, variant, onClick, disabled }: {
  label: string;
  active?: boolean;
  variant?: 'default' | 'green' | 'red';
  onClick?: () => void;
  disabled?: boolean;
}) {
  const classes = [
    'rcp-btn',
    active && 'rcp-btn--active',
    variant && `rcp-btn--${variant}`,
    disabled && 'rcp-btn--disabled'
  ].filter(Boolean).join(' ');
  return <button className={classes} onClick={onClick} disabled={disabled}>{label}</button>;
}

/**
 * Software-style RCP Panel
 */
export function SonyRcpPanel({ state, origins, neverReadsBack = false, confirmations, freshnessLimits, tally, cameraId = 1, disabled = false, capabilities, onCommand, onSetTally }: SonyRcpPanelProps) {
  const [autoIris, setAutoIris] = useState(false);
  const cmd = (c: string, params: Record<string, unknown> = {}) => onCommand(c, params);
  const can = (feature: keyof CameraCapabilities): boolean => !disabled && (capabilities?.[feature] ?? true);
  // BEDARF 46 — ein Wert ist markiert, wenn er GESENDET und nie
  // zurueckgelesen wurde. Wo der Weg ueberhaupt nichts zurueckliest, steht
  // der Satz EINMAL oben: zwanzig gleiche Markierungen an zwanzig Reglern
  // sind keine Auskunft mehr, sondern Tapete.
  const offen = (feld: keyof CameraState): boolean =>
    !neverReadsBack && istUnbestaetigt(origins, feld);

  // BEDARF 102 — das Alter tickt, also muss die Anzeige ticken. Einmal je
  // Sekunde und nicht haeufiger: es geht um Vielfache des Poll-Takts, nicht
  // um Millisekunden, und ein Pult, das sich sechzigmal je Sekunde neu
  // zeichnet, kostet Strom ohne eine einzige zusaetzliche Aussage.
  const [jetzt, setJetzt] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setJetzt(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  /**
   * Die Markierung fuer das ALTER eines Wertes.
   *
   * Ein unbestaetigter Wert bekommt sie nicht: der traegt bereits die
   * Markierung aus Bedarf 46, und zwei Markierungen an einer Zahl sind eine
   * zu viel.
   */
  const stand = (feld: keyof CameraState): { markClass?: string; markTitle?: string } => {
    if (neverReadsBack || offen(feld)) return {};
    const wann = confirmations?.[feld as string];
    return freshnessProps(freshnessOf(wann, jetzt, freshnessLimits), wann, jetzt);
  };
  
  // Convert values to display format
  // BEDARF 129 — kein erfundener Ausgangswert. `?? 0` stand hier fuer beide
  // Werte und liess das Pult "0dB" bzw. die erste ND-Stellung anzeigen,
  // solange die Kamera ihren Wert noch gar nicht gemeldet hatte. Wer dann auf
  // "+" drueckte, sprang von einer Anzeige aus, die niemand abgelesen hatte.
  // Unbekannt wird jetzt als unbekannt angezeigt, und der Trimm laeuft ueber
  // das relative Kommando des Busses, das seinerseits absagt, wenn der
  // aktuelle Wert fehlt (siehe `protocol/paintNudge.ts` in der Bruecke).
  const gainIdx = state.masterGain;
  const ndIdx = state.ndFilter;
  const ccIdx = 0;
  const detail = Math.round(((state.detailLevel ?? 128) - 128) / 12.8); // -10 to +10
  const irisValue = ((state.iris ?? 128) / 255 * 16).toFixed(1); // F1.4 - F16

  return (
    <div className={`rcp-panel ${disabled ? 'rcp-panel--disabled' : ''}`}>
      {/* BEDARF 46 — der Weg liest nichts zurueck. Einmal, ganz oben, weil er
          die Lesart JEDER Zahl darunter bestimmt. */}
      {neverReadsBack && <div className="rcp-noreadback">{NO_READBACK_NOTE}</div>}
      
      {/* ═══════ TOP BAR ═══════ */}
      <div className="rcp-topbar">
        <div className="rcp-topbar__left">
          <span className="rcp-tab rcp-tab--active">DATA</span>
          <span className="rcp-tab">ALARM</span>
        </div>
        <div className="rcp-topbar__center">
          <span className="rcp-camera-id">{String(cameraId).padStart(2, '0')}</span>
        </div>
        <div className="rcp-topbar__right">
          <RcpButton label="ACTIVE" active={tally.program} variant="green" onClick={() => onSetTally({ program: !tally.program })} disabled={!can('tallyProgram')} />
          <RcpButton label="CALL" onClick={() => cmd('call')} disabled={!can('call')} />
        </div>
      </div>

      {/* ═══════ MODE ROW ═══════ */}
      <div className="rcp-row rcp-row--mode">
        <RcpButton label="STANDARD" active disabled={disabled} />
      </div>

      {/* ═══════ FUNCTION BUTTONS ═══════ */}
      <div className="rcp-row rcp-row--functions">
        <RcpButton label="BARS" active={state.bars} onClick={() => cmd('setBars', { on: !(state.bars ?? false) })} disabled={!can('bars')} />
        <RcpButton label="CLOSE" onClick={() => cmd('close')} disabled={!can('call')} />
        <RcpButton label="D5600K" onClick={() => cmd('setColorTemp', { value: 5600 })} disabled={!can('colorTemp')} />
        <RcpButton label="CHARACTER" onClick={() => cmd('toggleCharacter')} disabled={!can('character')} />
      </div>

      {/* ═══════ GAIN ROW ═══════ */}
      <div className="rcp-row rcp-row--gain">
        <Selector 
          value={gainIdx === undefined ? '--' : GAIN_VALUES[gainIdx] ?? `#${gainIdx}`}
          label="MASTER GAIN"
          onChange={(d) => cmd('nudge', { parameter: 'masterGain', by: d })}
          disabled={!can('masterGain')}
          unconfirmed={offen('masterGain')} {...stand('masterGain')}
        />
        <div className="rcp-row__spacer" />
        <RcpButton label="AWB" onClick={() => cmd('autoWhiteBalance', { preset: 'A' })} disabled={!can('awb')} />
        <RcpButton label="ABB" onClick={() => cmd('autoBlackBalance')} disabled={!can('abb')} />
      </div>

      {/* ═══════ WHITE SECTION with Rotary Knobs ═══════ */}
      <div className="rcp-section rcp-section--knobs">
        <div className="rcp-section__header">
          <span className="rcp-section__label">WHITE</span>
          <span className="rcp-section__label">ATW</span>
        </div>
        <div className="rcp-knob-row">
          <RotaryKnob
            label="R"
            value={state.whiteR ?? 128}
            unconfirmed={offen('whiteR')} {...stand('whiteR')}
            unconfirmedTitle={UNCONFIRMED_NOTE}
            min={0}
            max={255}
            detent={128}
            onChange={(v) => cmd('setWhiteBalance', { r: v, g: state.whiteG ?? 128, b: state.whiteB ?? 128 })}
            disabled={!can('whiteBalance')}
            size="md"
            color="red"
            editable
          />
          <RotaryKnob
            label="G"
            value={state.whiteG ?? 128}
            unconfirmed={offen('whiteG')} {...stand('whiteG')}
            unconfirmedTitle={UNCONFIRMED_NOTE}
            min={0}
            max={255}
            detent={128}
            onChange={(v) => cmd('setWhiteBalance', { r: state.whiteR ?? 128, g: v, b: state.whiteB ?? 128 })}
            disabled={!can('whiteBalance')}
            size="md"
            color="green"
            editable
          />
          <RotaryKnob
            label="B"
            value={state.whiteB ?? 128}
            unconfirmed={offen('whiteB')} {...stand('whiteB')}
            unconfirmedTitle={UNCONFIRMED_NOTE}
            min={0}
            max={255}
            detent={128}
            onChange={(v) => cmd('setWhiteBalance', { r: state.whiteR ?? 128, g: state.whiteG ?? 128, b: v })}
            disabled={!can('whiteBalance')}
            size="md"
            color="blue"
            editable
          />
        </div>
      </div>

      {/* ═══════ BLACK SECTION with Rotary Knobs ═══════ */}
      <div className="rcp-section rcp-section--knobs">
        <div className="rcp-section__header">
          <span className="rcp-section__label">BLACK</span>
        </div>
        <div className="rcp-knob-row">
          <RotaryKnob
            label="MASTER"
            value={state.masterBlack ?? 128}
            unconfirmed={offen('masterBlack')} {...stand('masterBlack')}
            unconfirmedTitle={UNCONFIRMED_NOTE}
            min={0}
            max={255}
            detent={128}
            onChange={(v) => cmd('setMasterBlack', { value: v })}
            disabled={!can('masterBlack')}
            size="md"
            editable
          />
          <RotaryKnob
            label="R"
            value={state.blackR ?? 128}
            unconfirmed={offen('blackR')} {...stand('blackR')}
            unconfirmedTitle={UNCONFIRMED_NOTE}
            min={0}
            max={255}
            detent={128}
            onChange={(v) => cmd('setBlackBalance', { r: v, g: state.blackG ?? 128, b: state.blackB ?? 128 })}
            disabled={!can('blackBalance')}
            size="sm"
            color="red"
            editable
          />
          <RotaryKnob
            label="G"
            value={state.blackG ?? 128}
            unconfirmed={offen('blackG')} {...stand('blackG')}
            unconfirmedTitle={UNCONFIRMED_NOTE}
            min={0}
            max={255}
            detent={128}
            onChange={(v) => cmd('setBlackBalance', { r: state.blackR ?? 128, g: v, b: state.blackB ?? 128 })}
            disabled={!can('blackBalance')}
            size="sm"
            color="green"
            editable
          />
          <RotaryKnob
            label="B"
            value={state.blackB ?? 128}
            unconfirmed={offen('blackB')} {...stand('blackB')}
            unconfirmedTitle={UNCONFIRMED_NOTE}
            min={0}
            max={255}
            detent={128}
            onChange={(v) => cmd('setBlackBalance', { r: state.blackR ?? 128, g: state.blackG ?? 128, b: v })}
            disabled={!can('blackBalance')}
            size="sm"
            color="blue"
            editable
          />
        </div>
      </div>

      {/* ═══════ IRIS SECTION ═══════ */}
      <div className="rcp-section rcp-section--iris">
        <div className="rcp-iris-left">
          <label className="rcp-checkbox">
            <input 
              type="checkbox" 
              checked={autoIris}
              onChange={(e) => {
                setAutoIris(e.target.checked);
                cmd('setAutoIris', { on: e.target.checked });
              }}
              disabled={!can('autoIris')}
            />
            <span className="rcp-checkbox__label">AUTO IRIS</span>
          </label>
          <div className="rcp-filter-group">
            <Selector 
              value={ndIdx === undefined ? '--' : ND_VALUES[ndIdx] ?? `#${ndIdx}`}
              label="ND"
              onChange={(d) => cmd('nudge', { parameter: 'ndFilter', by: d })}
              disabled={!can('ndFilter')}
              unconfirmed={offen('ndFilter')} {...stand('ndFilter')}
            />
            <Selector 
              value={CC_VALUES[ccIdx] ?? 'A'} 
              label="CC"
              onChange={() => {}}
              disabled={!can('cc')}
            />
          </div>
        </div>
        <div className="rcp-iris-center">
          <div className="rcp-iris-display">
            <span
              className={`rcp-iris-display__value${offen('iris') ? ` ${UNCONFIRMED_CLASS}` : ''}`}
              title={offen('iris') ? UNCONFIRMED_NOTE : undefined}
            >
              {irisValue}
            </span>
            <span className="rcp-iris-display__label">IRIS</span>
          </div>
        </div>
        <div className="rcp-iris-right">
          <div className="rcp-fader">
            <div className="rcp-fader__scale">
              <span>3.4</span>
            </div>
            <div className="rcp-fader__track">
              <input 
                type="range" 
                min="0" 
                max="255" 
                value={state.iris ?? 128}
                onChange={(e) => cmd('setIris', { value: parseInt(e.target.value) })}
                disabled={!can('iris') || autoIris}
                className="rcp-fader__input"
              />
              <div 
                className="rcp-fader__handle"
                style={{ bottom: `${((state.iris ?? 128) / 255) * 100}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ═══════ COLOUR CORRECTION EXTRAS (Blackmagic) ═══════ */}
      {(can('contrast') || can('resetCc')) && (
        <div className="rcp-section rcp-section--cc">
          <div className="rcp-section__header">
            <span className="rcp-section__label">COLOR CORRECTION</span>
          </div>
          <div className="rcp-cc-row">
            {can('contrast') && (
              <label className="rcp-cc-slider">
                CONTRAST
                <input
                  type="range" min={0} max={255} defaultValue={128}
                  onChange={(e) => cmd('setContrast', { value: parseInt(e.target.value) })}
                  disabled={!can('contrast')}
                />
              </label>
            )}
            {can('resetCc') && (
              <RcpButton label="RESET CC" onClick={() => cmd('resetColorCorrection')} disabled={!can('resetCc')} />
            )}
          </div>
        </div>
      )}

      {/* ═══════ BOTTOM BAR ═══════ */}
      <div className="rcp-bottombar">
        <RcpButton label="PREVIEW" active={tally.preview} onClick={() => onSetTally({ preview: !tally.preview })} disabled={!can('tallyPreview')} />
        <div className="rcp-status-indicators">
          <span className="rcp-status rcp-status--out">OUT</span>
          <span className="rcp-status rcp-status--opt">OPT</span>
          <span className="rcp-status rcp-status--sync">SYNC</span>
          <span className="rcp-status rcp-status--drop">DROP</span>
        </div>
      </div>
    </div>
  );
}
