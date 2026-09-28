import React, { useEffect, useMemo, useState } from 'react';
import type { CameraSlot } from '../hooks/useBridge.ts';
import type { SwitcherSlot } from '../types.ts';
import { LayoutPicker } from './LayoutPicker.tsx';
import { layoutByMode, mainWindow, windowNumbers } from '../lib/layouts.ts';

/**
 * The switcher in the manner of a panel: a programme row over a preview row
 * and one CUT. Preview lives in the bridge, so a second screen shows the
 * same pre-selection. Keys: 1..9 preview, Shift+1..9 take, Enter/Space cut
 * (by `event.code`, so Shift+digit works on every keyboard layout).
 */

interface Props {
  switcher: SwitcherSlot;
  cameras: Record<number, CameraSlot>;
  onCommand: (cmd: string, params?: Record<string, unknown>) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  keysActive: boolean;
}

export const SOURCE_COUNT = 6;

export interface KeyAction { kind: 'preview' | 'program'; source: number }

/** Digit keys by code; `key` would be `!` or `"` with Shift held. */
export function keyToAction(code: string, shift: boolean, sourceCount: number): KeyAction | { kind: 'cut' } | null {
  if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') return { kind: 'cut' };
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (!digit) return null;
  const source = Number(digit[1]);
  if (source > sourceCount) return null;
  return shift ? { kind: 'program', source } : { kind: 'preview', source };
}

export function SwitcherPanel({ switcher, cameras, onCommand, onConnect, onDisconnect, keysActive }: Props) {
  const state = switcher.state;
  const connected = switcher.connected && !!state;
  const labels = switcher.inputLabels ?? switcher.config.inputLabels ?? ['HDMI-1', 'HDMI-2', 'SDI-1', 'SDI-2', 'SDI-3', 'SDI-4'];
  const [freezeArmed, setFreezeArmed] = useState(false);

  /** Source → the camera on it, so the row can say "Stage left" instead of "SDI-1". */
  const cameraOnInput = useMemo(() => {
    const map: Record<number, CameraSlot> = {};
    for (const cam of Object.values(cameras)) {
      const input = cam.config.switcherInput ?? 0;
      if (input > 0 && !map[input]) map[input] = cam;
    }
    return map;
  }, [cameras]);

  const nameFor = (source: number) => {
    const cam = cameraOnInput[source];
    return cam?.plan?.label ?? cam?.config.label ?? labels[source - 1] ?? `Input ${source}`;
  };
  const signalFor = (source: number): boolean | undefined => {
    const key = labels[source - 1];
    return key ? state?.inputSignals?.[key] : undefined;
  };

  useEffect(() => {
    if (!keysActive || !connected) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const action = keyToAction(e.code, e.shiftKey, SOURCE_COUNT);
      if (!action) return;
      e.preventDefault();
      if (action.kind === 'cut') onCommand('cut');
      else if (action.kind === 'program') onCommand('take', { source: action.source });
      else onCommand('preview', { source: action.source });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keysActive, connected, onCommand]);

  useEffect(() => {
    if (!freezeArmed) return;
    const t = setTimeout(() => setFreezeArmed(false), 4000);
    return () => clearTimeout(t);
  }, [freezeArmed]);

  const mode = state?.mode ?? 0;
  const layout = layoutByMode(mode);
  const pgmWindow = switcher.config.pgmWindow && windowNumbers(mode).includes(switcher.config.pgmWindow) ? switcher.config.pgmWindow : mainWindow(mode);
  const serialAvailable = !!switcher.config.serial && switcher.config.serial.transport !== 'none';
  const canCut = connected && (state?.preview ?? 0) > 0 && state?.preview !== state?.program;
  const sources = Array.from({ length: SOURCE_COUNT }, (_, i) => i + 1);

  return (
    <div className="stack">
      <div className="headline">
        <span className="headline__kicker">Switcher</span>
        <span className="headline__title">{switcher.config.label || 'VIS-CATC'}</span>
        <span className="headline__meta">
          <span className={`chip ${connected ? 'chip--on' : ''}`}>{connected ? 'connected' : 'offline'}</span>
          {state?.version && <span>FW {state.version}</span>}
          <span>{switcher.config.path === 'serial' ? 'RS-232' : 'HTTP'}</span>
          {connected ? (
            <button className="btn btn--sm" onClick={onDisconnect}>Disconnect</button>
          ) : (
            <button className="btn btn--sm btn--primary" onClick={onConnect}>Connect</button>
          )}
        </span>
      </div>

      {!connected && (
        <p className="hint">
          {switcher.config.host ? `Not connected to ${switcher.config.host}. ` : 'No address yet. '}
          Set it up on the right, then connect. The rows come alive with the first status reply.
        </p>
      )}

      {/* PGM row — what goes out */}
      <div className="bus">
        <span className="bus__label">PGM</span>
        <div className="bus__row">
          {sources.map((s) => (
            <button
              key={s}
              type="button"
              className={`src ${state?.program === s ? 'src--program' : ''}`}
              disabled={!connected}
              onClick={() => onCommand('take', { source: s })}
              title={`Take ${nameFor(s)} to programme (Shift+${s})`}
            >
              <span className="src__num">{s} · {labels[s - 1] ?? ''}</span>
              <span className="src__name">{nameFor(s)}</span>
              <span className={`src__signal ${signalFor(s) ? 'src__signal--on' : ''}`} title={signalFor(s) === undefined ? 'signal unknown' : signalFor(s) ? 'signal' : 'no signal'} />
            </button>
          ))}
        </div>
      </div>

      {/* PVW row — the pre-selection, bridge-side, no device command */}
      <div className="bus">
        <span className="bus__label">PVW</span>
        <div className="bus__row">
          {sources.map((s) => (
            <button
              key={s}
              type="button"
              className={`src ${state?.preview === s ? 'src--preview' : ''}`}
              disabled={!connected}
              onClick={() => onCommand('preview', { source: state?.preview === s ? 0 : s })}
              title={`Preview ${nameFor(s)} (${s})`}
            >
              <span className="src__num">{s}</span>
              <span className="src__name">{nameFor(s)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="bus__side">
        <span />
        <div className="row">
          <button type="button" className="btn btn--primary cut" disabled={!canCut} onClick={() => onCommand('cut')} title="Cut (Enter / Space)">
            CUT
          </button>
          <span className="hint">
            <span className="kbd">1</span>…<span className="kbd">6</span> preview · <span className="kbd">Shift</span>+digit take · <span className="kbd">Enter</span> cut
          </span>
        </div>
      </div>

      <div className="headline">
        <span className="headline__kicker" style={{ visibility: 'hidden' }}>Layout</span>
        <span className="headline__title">Output picture</span>
        <span className="headline__meta">{layout ? `${layout.label} · ${layout.name} · programme in window ${pgmWindow}` : ''}</span>
      </div>
      <LayoutPicker mode={mode} outputs={state?.outputs ?? {}} onPick={(m) => onCommand('setLayout', { mode: m })} disabled={!connected} />

      {layout && layout.windows.length > 1 && (
        <details>
          <summary className="hint">Windows of this layout — which source sits where</summary>
          <div className="windows" style={{ marginTop: 8 }}>
            {windowNumbers(mode).map((w) => (
              <label key={w} className="field">
                <span>Window {w}{w === pgmWindow ? ' · programme' : ''}</span>
                <select
                  className="select-group__select"
                  value={state?.outputs?.[w] ?? 0}
                  disabled={!connected}
                  onChange={(e) => onCommand('route', { source: Number(e.target.value), window: w })}
                >
                  <option value={0}>–</option>
                  {sources.map((s) => <option key={s} value={s}>{s} · {nameFor(s)}</option>)}
                </select>
              </label>
            ))}
          </div>
        </details>
      )}

      <div className="row">
        <span className="hint" style={{ marginRight: 8 }}>Audio</span>
        {[0, 1, 2, 3].map((a) => (
          <button
            key={a}
            type="button"
            className={`btn btn--sm ${state?.audio === a ? 'btn--on' : ''}`}
            disabled={!connected}
            onClick={() => onCommand('setAudio', { channel: a })}
          >
            {a + 1}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {serialAvailable && (
          <button
            type="button"
            className={`btn btn--sm ${freezeArmed ? 'armed' : ''}`}
            disabled={!connected}
            onClick={() => {
              if (freezeArmed) { onCommand('freeze', { seconds: 3 }); setFreezeArmed(false); }
              else setFreezeArmed(true);
            }}
            title="Freeze the output picture for three seconds (serial route only). Two clicks."
          >
            {freezeArmed ? 'Freeze — click again' : 'Freeze'}
          </button>
        )}
        <button type="button" className="btn btn--sm" disabled={!connected} onClick={() => onCommand('refresh')} title="Read status, signals and version from the device">
          Refresh
        </button>
      </div>
    </div>
  );
}
