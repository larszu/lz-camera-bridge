/**
 * WebSocket hook for Camera Bridge
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { CameraState, CameraStatesByNumber, BridgeConfig, WiznetDevice, SonyUsbDevice, TallyState } from '../types.ts';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

interface UseBridgeReturn {
  status: ConnectionStatus;
  cameraConnected: boolean;
  state: CameraState;
  cameraStates: CameraStatesByNumber;
  config: BridgeConfig;
  ports: string[];
  wiznetDevices: WiznetDevice[];
  sonyUsbDevices: SonyUsbDevice[];
  tally: TallyState;
  errorMsg: string | null;
  send: (type: string, payload?: Record<string, unknown>) => void;
  connectCamera: () => void;
  disconnectCamera: () => void;
  listPorts: () => void;
  setConfig: (config: Partial<BridgeConfig>) => void;
  discoverWiznet: () => void;
  configureWiznet: (deviceIp: string, deviceConfig: Record<string, unknown>) => void;
  discoverSonyUsb: () => void;
  setTally: (tally: Partial<TallyState>) => void;
}

interface StateResponseMessage {
  type: 'state';
  state?: CameraState;
  cameraNumber?: number;
}

const bridgeHost = window.location.hostname || 'localhost';
const WS_URL = `ws://${bridgeHost}:9700`;

export function useBridge(): UseBridgeReturn {
  const ws = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [cameraConnected, setCameraConnected] = useState(false);
  const [state, setState] = useState<CameraState>({});
  const [cameraStates, setCameraStates] = useState<CameraStatesByNumber>({});
  const [config, setConfigState] = useState<BridgeConfig>({ connectionMode: 'tcp', tcpHost: '192.168.1.10', tcpPort: 7700, serialPath: '', baudRate: 38400, ccuId: 0 });
  const [ports, setPorts] = useState<string[]>([]);
  const [wiznetDevices, setWiznetDevices] = useState<WiznetDevice[]>([]);
  const [sonyUsbDevices, setSonyUsbDevices] = useState<SonyUsbDevice[]>([]);
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
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case 'state': {
            const stateMsg = msg as StateResponseMessage;
            if (typeof stateMsg.cameraNumber === 'number') {
              setCameraStates((prev) => ({
                ...prev,
                [stateMsg.cameraNumber!]: { ...(prev[stateMsg.cameraNumber!] ?? {}), ...(stateMsg.state ?? {}) },
              }));
            } else {
              setState((prev) => ({ ...prev, ...stateMsg.state }));
            }
            break;
          }
          case 'connected':
            setCameraConnected(true);
            break;
          case 'disconnected':
            setCameraConnected(false);
            setState({});
            setCameraStates({});
            break;
          case 'error':
            setErrorMsg(msg.message as string);
            break;
          case 'ports':
            setPorts(msg.ports as string[]);
            break;
          case 'config':
            setConfigState(msg.config as BridgeConfig);
            break;
          case 'wiznetDevices':
            setWiznetDevices(msg.devices as WiznetDevice[]);
            break;
          case 'sonyUsbDevices':
            setSonyUsbDevices(msg.devices as SonyUsbDevice[]);
            if ((msg.devices as SonyUsbDevice[]).length === 0 && msg.reason) {
              setErrorMsg(msg.reason as string);
            } else {
              setErrorMsg(null);
            }
            break;
          case 'wiznetConfigResult':
            if (msg.success) {
              setErrorMsg(null);
            } else {
              setErrorMsg(`Failed to configure WIZ108SR at ${msg.ip}`);
            }
            break;
          case 'tally':
            setTallyState(msg.tally as TallyState);
            break;
        }
      } catch { /* ignore malformed */ }
    };

    socket.onclose = () => {
      setStatus('disconnected');
      setCameraConnected(false);
      // Reconnect after 3s
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
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type, ...payload }));
    }
  }, []);

  const connectCamera = useCallback(() => send('connect'), [send]);
  const disconnectCamera = useCallback(() => send('disconnect'), [send]);
  const listPorts = useCallback(() => send('listPorts'), [send]);

  const setConfig = useCallback((cfg: Partial<BridgeConfig>) => {
    send('setConfig', { config: cfg });
  }, [send]);

  const discoverWiznet = useCallback(() => send('discoverWiznet'), [send]);

  const configureWiznet = useCallback((deviceIp: string, deviceConfig: Record<string, unknown>) => {
    send('configureWiznet', { deviceIp, deviceConfig });
  }, [send]);

  const discoverSonyUsb = useCallback(() => send('discoverSonyUsb'), [send]);

  const setTally = useCallback((t: Partial<TallyState>) => {
    send('setTally', { tally: t });
  }, [send]);

  return { status, cameraConnected, state, cameraStates, config, ports, wiznetDevices, sonyUsbDevices, tally, errorMsg, send, connectCamera, disconnectCamera, listPorts, setConfig, discoverWiznet, configureWiznet, discoverSonyUsb, setTally };
}
