/**
 * Common interface for the simpler network camera backends (Z CAM, Panasonic
 * PTZ, VISCA, JVC, BirdDog …). Implementing this lets BridgeServer wire and
 * route them all through one generic code path instead of a branch per type.
 *
 * Events:
 *   'connected'    (info: unknown)
 *   'stateChanged' (state: Partial<CameraState>)   // already mapped
 *   'disconnected' ()
 *   'error'        (err: Error)
 */
import { EventEmitter } from 'events';

export interface GenericCameraClient extends EventEmitter {
  readonly isConnected: boolean;
  connect(): Promise<unknown>;
  disconnect(): void | Promise<void>;
  /** Returns true if the command was applied, false if unsupported. */
  handleRcpCommand(cmd: string, params: Record<string, unknown>): Promise<boolean>;
}

/** Shared fetch helper: GET/PUT/POST JSON or text with a timeout. */
export async function httpRequest(
  url: string,
  init: { method?: string; body?: unknown; json?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: init.json ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body === undefined ? undefined : init.json ? JSON.stringify(init.body) : String(init.body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
