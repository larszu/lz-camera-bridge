/**
 * WebSocket hook for the multi-camera Camera Bridge.
 *
 * The bridge holds many camera slots keyed by number; this hook mirrors that:
 * `cameras` is the authoritative slot list (config + connected) from the
 * bridge, `cameraStates` the live paint state per number. All actions are
 * camera-scoped.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  CameraState, CameraStatesByNumber, BridgeConfig, WiznetDevice,
  SonyUsbDevice, SonyMncDevice, HidDevice, TallyState,
} from '../types.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

export interface CameraSlot {
  cameraNumber: number;
  config: BridgeConfig;
  connected: boolean;
}

const bridgeHost = window.location.hostname || 'localhost';
const WS_URL = `ws://${bridgeHost}:9700`;

export function useBridge() {
  const ws = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [cameras, setCameras] = useState<Record<number, CameraSlot>>({});
  const [cameraStates, setCameraStates] = useState<CameraStatesByNumber>({});
  const [ports, setPorts] = useState<string[]>([]);
  const [wiznetDevices, setWiznetDevices] = useState<WiznetDevice[]>([]);
  const [sonyUsbDevices, setSonyUsbDevices] = useState<SonyUsbDevice[]>([]);
  const [sonyMncDevices, setSonyMncDevices] = useState<SonyMncDevice[]>([]);
  const [hidDevices, setHidDevices] = useState<HidDevice[]>([]);
  const [controlSurfaceActive, setControlSurfaceActive] = useState(false);
  const [tally, setTallyState] = useState<TallyState>({ program: false, preview: false, isoRec: false });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;
    setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      setStatus('error');
      setErrorMsg(`WebSocket connection failed: ${WS_URL}`);
      return;
    }

    socket.onopen = () => {
      setStatus('connected');
      setErrorMsg(null);
      socket.send(JSON.stringify({ type: 'listCameras' }));
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case 'cameras': {
            const rec: Record<number, CameraSlot> = {};
            for (const c of msg.cameras as CameraSlot[]) rec[c.cameraNumber] = c;
            setCameras(rec);
            break;
          }
          case 'state':
            if (typeof msg.cameraNumber === 'number') {
              setCameraStates((prev) => ({
                ...prev,
                [msg.cameraNumber]: { ...(prev[msg.cameraNumber] ?? {}), ...(msg.state ?? {}) },
              }));
            }
            break;
          case 'cameraConnected':
            setErrorMsg(null);
            break;
          case 'cameraDisconnected':
            if (typeof msg.cameraNumber === 'number') {
              setCameraStates((prev) => {
                const next = { ...prev };
                delete next[msg.cameraNumber];
                return next;
              });
            }
            break;
          case 'error':
            setErrorMsg(msg.message as string);
            break;
          case 'ports':
            setPorts(msg.ports as string[]);
            break;
          case 'wiznetDevices':
            setWiznetDevices(msg.devices as WiznetDevice[]);
            break;
          case 'sonyUsbDevices':
            setSonyUsbDevices(msg.devices as SonyUsbDevice[]);
            if ((msg.devices as SonyUsbDevice[]).length === 0 && msg.reason) setErrorMsg(msg.reason as string);
            break;
          case 'sonyMncDevices':
            setSonyMncDevices(msg.devices as SonyMncDevice[]);
            break;
          case 'hidDevices':
            setHidDevices(msg.devices as HidDevice[]);
            if ((msg.devices as HidDevice[]).length === 0 && msg.reason) setErrorMsg(msg.reason as string);
            break;
          case 'controlSurface':
            setControlSurfaceActive(Boolean(msg.active));
            break;
          case 'wiznetConfigResult':
            setErrorMsg(msg.success ? null : `Failed to configure WIZ108SR at ${msg.ip}`);
            break;
          case 'tally':
            setTallyState(msg.tally as TallyState);
            break;
        }
      } catch { /* ignore malformed */ }
    };

    socket.onclose = () => {
      setStatus('disconnected');
      setTimeout(connect, 3000);
    };
    socket.onerror = () => {
      setStatus('error');
      setErrorMsg('WebSocket connection failed');
    };
    ws.current = socket;
  }, []);

  useEffect(() => {
    connect();
    return () => ws.current?.close();
  }, [connect]);

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type, ...payload }));
  }, []);

  // ── Camera actions ──────────────────────────────────────────────────────
  const setCameraConfig = useCallback((cameraNumber: number, config: Partial<BridgeConfig>) =>
    send('setCameraConfig', { cameraNumber, config }), [send]);
  const connectCamera = useCallback((cameraNumber: number) => send('connectCamera', { cameraNumber }), [send]);
  const disconnectCamera = useCallback((cameraNumber: number) => send('disconnectCamera', { cameraNumber }), [send]);
  const removeCamera = useCallback((cameraNumber: number) => send('removeCamera', { cameraNumber }), [send]);
  const sendCommand = useCallback((cameraNumber: number, cmd: string, params: Record<string, unknown> = {}) =>
    send('command', { cameraNumber, cmd, params }), [send]);

  // ── Discovery / global ──────────────────────────────────────────────────
  const listPorts = useCallback(() => send('listPorts'), [send]);
  const discoverWiznet = useCallback(() => send('discoverWiznet'), [send]);
  const configureWiznet = useCallback((deviceIp: string, deviceConfig: Record<string, unknown>) =>
    send('configureWiznet', { deviceIp, deviceConfig }), [send]);
  const discoverSonyUsb = useCallback(() => send('discoverSonyUsb'), [send]);
  const discoverSonyMnc = useCallback(() => send('discoverSonyMnc'), [send]);
  const listHidDevices = useCallback(() => send('listHidDevices'), [send]);
  const enableControlSurface = useCallback((surface: Record<string, unknown>) => send('enableControlSurface', { surface }), [send]);
  const disableControlSurface = useCallback(() => send('disableControlSurface'), [send]);
  const setTally = useCallback((t: Partial<TallyState>) => send('setTally', { tally: t }), [send]);

  return {
    status, cameras, cameraStates, ports, wiznetDevices, sonyUsbDevices, sonyMncDevices,
    hidDevices, controlSurfaceActive, tally, errorMsg,
    send, setCameraConfig, connectCamera, disconnectCamera, removeCamera, sendCommand,
    listPorts, discoverWiznet, configureWiznet, discoverSonyUsb, discoverSonyMnc,
    listHidDevices, enableControlSurface, disableControlSurface, setTally,
  };
}
