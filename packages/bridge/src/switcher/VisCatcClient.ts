/**
 * Vissonic VIS-CATC as a bridge device — a switcher, not a camera.
 *
 * The camera backends share `handleRcpCommand`; a switcher has a different
 * vocabulary (route, layout, audio, freeze, cut), so it gets its own class
 * and its own slot family in the bridge instead of being squeezed into a
 * camera slot with a fake paint state.
 *
 * Two routes to the device, chosen per site (`path`):
 *
 *  - `http`    POST / on the device's web port. Reads status back.
 *  - `serial`  the RS-232 verb list, either through a TCP-serial gateway
 *              (Moxa, USR-TCP232 — `serial.transport: 'tcp'`) or a local
 *              port on the bridge host (`serial.transport: 'port'`, via the
 *              `serialport` library the bridge already carries).
 *
 * Freeze exists only on the serial route; status only on the network route.
 * When switching over serial, the network status is still polled for
 * readback, but the last serial switch is trusted until the next poll
 * confirms it — otherwise the programme row snapped back to a stale value
 * after every cut (a defect of the predecessor).
 *
 * The bus (PGM/PVW) lives here too: `preview` is a bridge-side selection,
 * `program` is what the device reports for the main window of the current
 * layout. See `switcherBus.ts`.
 */
import { EventEmitter } from 'events';
import { createConnection } from 'net';
import {
  DEFAULT_INPUT_LABELS,
  httpAudio, httpInputInfo, httpLayout, httpRoute, httpStatus, httpVersion,
  isCompleteSerialReply,
  parseInputInfo, parseStatus, parseSwitchReply, parseVersion,
  serialAudio, serialFreezeTime, serialLayout, serialRoute, serialSetFreeze,
  type FormRequest,
} from './visCatcProtocol.js';
import { mainWindow, windowNumbers } from './layouts.js';
import { cut, selectPreview, takeProgram, type BusState } from './switcherBus.js';

export type SwitcherPath = 'http' | 'serial';

export interface SwitcherSerialConfig {
  transport: 'none' | 'tcp' | 'port';
  /** TCP-serial gateway. */
  host?: string;
  port?: number;
  /** Local serial device on the bridge host. */
  devicePath?: string;
  baudRate?: number;
}

export interface SwitcherConfig {
  kind?: 'vis-catc';
  label?: string;
  host?: string;
  port?: number;
  path?: SwitcherPath;
  serial?: SwitcherSerialConfig;
  inputLabels?: string[];
  /** Which window is the programme. Empty: the largest window of the layout. */
  pgmWindow?: number;
  timeoutMs?: number;
}

export interface SwitcherState {
  /** window → source */
  outputs: Record<number, number>;
  mode: number;
  audio: number;
  inputSignals: Record<string, boolean>;
  version: string | null;
  /** Source on the programme window. 0 = unknown. */
  program: number;
  /** Bridge-side pre-selection. 0 = none. */
  preview: number;
  /** When the device last answered a status poll (ms since epoch), or null. */
  readAt: number | null;
}

const POLL_MS = 4000;
const DEFAULT_TIMEOUT_MS = 2500;

interface SendResult { ok: boolean; body: string; error?: string }

export class VisCatcClient extends EventEmitter {
  readonly config: Required<Pick<SwitcherConfig, 'host' | 'port' | 'path' | 'timeoutMs'>> & SwitcherConfig;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** A switch sent over serial, trusted until the next poll agrees. */
  private trustedRoute: { window: number; source: number; until: number } | null = null;
  private _state: SwitcherState = {
    outputs: {}, mode: 0, audio: 0, inputSignals: {}, version: null, program: 0, preview: 0, readAt: null,
  };

  constructor(cfg: SwitcherConfig) {
    super();
    this.config = {
      ...cfg,
      host: cfg.host ?? '',
      port: cfg.port ?? 80,
      path: cfg.path ?? 'http',
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  get isConnected(): boolean { return this.connected; }
  get state(): SwitcherState { return { ...this._state, outputs: { ...this._state.outputs }, inputSignals: { ...this._state.inputSignals } }; }
  get inputLabels(): string[] { return this.config.inputLabels?.length ? this.config.inputLabels : DEFAULT_INPUT_LABELS; }

  /** The programme window of the current layout. */
  programWindow(): number {
    const wanted = this.config.pgmWindow;
    if (wanted && windowNumbers(this._state.mode).includes(wanted)) return wanted;
    return mainWindow(this._state.mode);
  }

  async connect(): Promise<void> {
    if (!this.config.host) throw new Error('Switcher: no host configured');
    const first = await this.refresh();
    if (!first) throw new Error(`Switcher ${this.config.host}: no answer to status`);
    this.connected = true;
    this.emit('connected', { host: this.config.host, path: this.config.path });
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
  }

  disconnect(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.connected = false;
    this.emit('disconnected');
  }

  // ── Bus ────────────────────────────────────────────────────────────────────

  private bus(): BusState { return { program: this._state.program, preview: this._state.preview }; }

  setPreview(source: number): void {
    this._state = { ...this._state, ...selectPreview(this.bus(), source) };
    this.emit('stateChanged', this.state);
  }

  async doCut(): Promise<boolean> {
    const r = cut(this.bus());
    if (!r.switchTo) return false;
    return this.commitBus(r.state, r.switchTo);
  }

  async take(source: number): Promise<boolean> {
    const r = takeProgram(this.bus(), source);
    if (!r.switchTo) return false;
    return this.commitBus(r.state, r.switchTo);
  }

  /**
   * Route, then update the bus — not the other way round. When the device
   * refuses, the panel keeps showing what is actually on air instead of a
   * programme that never happened (the predecessor set the preview first
   * and ignored the result).
   */
  private async commitBus(next: BusState, switchTo: number): Promise<boolean> {
    const ok = await this.route(switchTo, this.programWindow());
    if (!ok) return false;
    this._state = { ...this._state, ...next };
    this.emit('stateChanged', this.state);
    return true;
  }

  // ── Device verbs ──────────────────────────────────────────────────────────────

  async route(source: number, window: number): Promise<boolean> {
    const res = this.config.path === 'serial'
      ? await this.sendSerial(serialRoute(source, window), true)
      : await this.sendHttp(httpRoute(source, window));
    if (!res.ok) { this.fail(`Route ${source}→${window}: ${res.error}`); return false; }
    const echo = this.config.path === 'serial' ? parseSwitchReply(res.body) : null;
    const outputs = { ...this._state.outputs, [window]: echo?.source ?? source };
    this.trustedRoute = { window, source, until: Date.now() + 2 * POLL_MS };
    this._state = { ...this._state, outputs };
    this.deriveProgram();
    this.emit('stateChanged', this.state);
    return true;
  }

  async setLayout(mode: number): Promise<boolean> {
    const res = this.config.path === 'serial'
      ? await this.sendSerial(serialLayout(mode), true)
      : await this.sendHttp(httpLayout(mode));
    if (!res.ok) { this.fail(`Layout ${mode}: ${res.error}`); return false; }
    this._state = { ...this._state, mode };
    this.deriveProgram();
    this.emit('stateChanged', this.state);
    return true;
  }

  async setAudio(channel: number): Promise<boolean> {
    const res = this.config.path === 'serial'
      ? await this.sendSerial(serialAudio(channel), true)
      : await this.sendHttp(httpAudio(channel));
    if (!res.ok) { this.fail(`Audio ${channel}: ${res.error}`); return false; }
    this._state = { ...this._state, audio: channel };
    this.emit('stateChanged', this.state);
    return true;
  }

  /** Serial only: the network route has no freeze verb. */
  async freeze(seconds = 3): Promise<boolean> {
    if (this.config.serial?.transport === 'none' || !this.config.serial) {
      this.fail('Freeze needs the serial route');
      return false;
    }
    const a = await this.sendSerial(serialFreezeTime(seconds), true);
    if (!a.ok) { this.fail(`Freeze: ${a.error}`); return false; }
    const b = await this.sendSerial(serialSetFreeze(), false);
    if (!b.ok) { this.fail(`Freeze: ${b.error}`); return false; }
    return true;
  }

  /**
   * Status, input signals and version — three requests, never overlapping:
   * a poll that is still running is not started again (the predecessor
   * stacked them when the device was slow).
   */
  async refresh(): Promise<boolean> {
    if (this.polling) return true;
    this.polling = true;
    try {
      const status = await this.sendHttp(httpStatus());
      const parsed = status.ok ? parseStatus(status.body) : null;
      if (!parsed) {
        if (this.connected) this.fail(`Status: ${status.error ?? 'unreadable answer'}`);
        return false;
      }
      const outputs = { ...parsed.outputs };
      const trusted = this.trustedRoute;
      if (trusted) {
        if (outputs[trusted.window] === trusted.source || Date.now() > trusted.until) this.trustedRoute = null;
        else outputs[trusted.window] = trusted.source;
      }
      const inputs = await this.sendHttp(httpInputInfo());
      const version = this._state.version ?? (await this.sendHttp(httpVersion()));
      this._state = {
        ...this._state,
        outputs,
        mode: parsed.mode,
        audio: parsed.audio,
        inputSignals: (inputs.ok && parseInputInfo(inputs.body)) || this._state.inputSignals,
        version: typeof version === 'string' ? version : (version.ok && parseVersion(version.body)) || null,
        readAt: Date.now(),
      };
      this.deriveProgram();
      this.emit('stateChanged', this.state);
      return true;
    } finally {
      this.polling = false;
    }
  }

  private deriveProgram(): void {
    const program = this._state.outputs[this.programWindow()] ?? 0;
    // A preview equal to the programme is no pre-selection any more.
    const preview = this._state.preview === program ? 0 : this._state.preview;
    this._state = { ...this._state, program, preview };
  }

  private fail(message: string): void {
    this.emit('error', new Error(message));
  }

  // ── Transports ─────────────────────────────────────────────────────────────────

  private baseUrl(): string {
    const suffix = this.config.port === 80 ? '' : `:${this.config.port}`;
    return `http://${this.config.host}${suffix}`;
  }

  protected async sendHttp(req: FormRequest): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl()}${req.path}`, {
        method: req.method,
        headers: { 'Content-Type': req.contentType, Referer: `${this.baseUrl()}/` },
        body: req.body,
        signal: controller.signal,
      });
      const body = await res.text();
      if (!res.ok) return { ok: false, body, error: `HTTP ${res.status}` };
      return { ok: true, body };
    } catch (err) {
      const e = err as Error;
      return { ok: false, body: '', error: e.name === 'AbortError' ? `timeout after ${this.config.timeoutMs} ms` : e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  protected async sendSerial(command: string, expectReply: boolean): Promise<SendResult> {
    const s = this.config.serial;
    if (!s || s.transport === 'none') return { ok: false, body: '', error: 'no serial route configured' };
    if (s.transport === 'tcp') {
      if (!s.host) return { ok: false, body: '', error: 'serial gateway host missing' };
      return sendOverTcp(s.host, s.port ?? 4001, command, this.config.timeoutMs, expectReply);
    }
    if (!s.devicePath) return { ok: false, body: '', error: 'serial device path missing' };
    return sendOverPort(s.devicePath, s.baudRate ?? 9600, command, this.config.timeoutMs, expectReply);
  }
}

/** One command through a TCP-serial gateway. Opens and closes per command: the gateways allow one client. */
export function sendOverTcp(host: string, port: number, command: string, timeoutMs: number, expectReply: boolean): Promise<SendResult> {
  return new Promise((resolve) => {
    let settled = false;
    let received = '';
    const finish = (r: SendResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    const socket = createConnection({ host, port }, () => {
      socket.write(command, 'ascii');
      if (!expectReply) setTimeout(() => finish({ ok: true, body: '' }), 120);
    });
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => {
      received += chunk.toString('ascii');
      if (isCompleteSerialReply(received)) finish({ ok: true, body: received });
    });
    socket.on('timeout', () =>
      finish(received ? { ok: true, body: received } : { ok: false, body: '', error: `timeout after ${timeoutMs} ms` }),
    );
    socket.on('error', (err) => finish({ ok: false, body: '', error: err.message }));
    // Closed without a byte: for a command that expects an answer that is a
    // failure, not a success with an empty body.
    socket.on('close', () =>
      finish(received || !expectReply ? { ok: true, body: received } : { ok: false, body: '', error: 'gateway closed without a reply' }),
    );
  });
}

/** One command on a local serial port via `serialport` (no `stty`, works on Windows too). */
export async function sendOverPort(path: string, baudRate: number, command: string, timeoutMs: number, expectReply: boolean): Promise<SendResult> {
  const { SerialPort } = await import('serialport');
  return new Promise((resolve) => {
    let settled = false;
    let received = '';
    let port: InstanceType<typeof SerialPort> | null = null;
    const finish = (r: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port?.close(() => {});
      resolve(r);
    };
    const timer = setTimeout(
      () => finish(received ? { ok: true, body: received } : expectReply ? { ok: false, body: '', error: `timeout after ${timeoutMs} ms` } : { ok: true, body: '' }),
      timeoutMs,
    );
    port = new SerialPort({ path, baudRate, dataBits: 8, parity: 'none', stopBits: 1 }, (err) => {
      if (err) { finish({ ok: false, body: '', error: err.message }); return; }
      port!.write(command, 'ascii');
      if (!expectReply) setTimeout(() => finish({ ok: true, body: '' }), 120);
    });
    port.on('data', (chunk: Buffer) => {
      received += chunk.toString('ascii');
      if (isCompleteSerialReply(received)) finish({ ok: true, body: received });
    });
    port.on('error', (err: Error) => finish({ ok: false, body: '', error: err.message }));
  });
}
