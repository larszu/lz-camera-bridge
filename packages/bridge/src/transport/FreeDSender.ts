/**
 * Sending FreeD D1 packets over UDP.
 *
 * `protocol/FreeD.ts` builds the bytes and does nothing else: no socket, no
 * clock. This file is the other half — the destination, the rate, and what
 * happens on a tick where the sample is not complete.
 *
 * ── NO DEFAULT ADDRESS, NO DEFAULT PORT, NO DEFAULT RATE ───────────────────
 *
 * All three are required. That is deliberate and it is the house rule applied
 * to configuration rather than to measurements:
 *
 *   - FreeD has **no registered UDP port**. Every consumer is told its port by
 *     whoever set the system up; the numbers that circulate (6301 among them)
 *     are site conventions, not a specification. A default here would be a
 *     guess wearing the clothes of a standard, and the first person to hit it
 *     would debug a silent receiver instead of reading an error.
 *   - The rate is a property of the *installation*, not of the protocol.
 *     Tracking is normally sent once per video field or frame, so 25, 50 or
 *     60 Hz are the usual numbers — but which one is right depends on the
 *     format the show runs in, and this program does not know that.
 *
 * So the caller states all three. `createFreeDSender` rejects a rate that is
 * not positive and finite, and a port outside 1..65535, rather than quietly
 * repairing either.
 *
 * ── AN INCOMPLETE SAMPLE IS NOT SENT ───────────────────────────────────────
 *
 * `encodeFreeD` refuses a sample with a null axis, and this sender does not
 * work around that. A tick with an incomplete sample sends nothing, counts
 * itself, and names the missing axes to `onIncomplete`. Filling the gap with
 * zeroes would put a camera at the origin pointing straight ahead — a claim
 * nobody made — and the receiver has no way to tell that apart from a real
 * measurement.
 *
 * Likewise a sender that has never been given a sample sends nothing. Silence
 * on the wire is the honest state of "no tracking yet".
 */
import dgram from 'dgram';

import { encodeFreeD, type FreeDSample } from '../protocol/FreeD.js';

export interface FreeDSenderOptions {
  /** Destination host or IPv4 address. Unicast, broadcast or multicast. */
  host: string;
  /** Destination UDP port. Required — see the module comment. */
  port: number;
  /** Packets per second. Required — see the module comment. */
  rateHz: number;
  /**
   * Called on a tick whose sample is missing axes, with the axes named.
   * Optional: a caller that only wants the counter can leave it out.
   */
  onIncomplete?: (missing: readonly (keyof FreeDSample)[]) => void;
  /** Called when the socket itself fails. Without it, errors are swallowed. */
  onError?: (err: Error) => void;
}

/**
 * Why a tick sent nothing. Three different states, and they are not the same
 * report: `no-sample` is "nothing has arrived yet", `incomplete` is "the axes
 * are not all known", `not-open` is a defect in this file's own bookkeeping.
 */
export type SendeAbbruch = 'no-sample' | 'incomplete' | 'not-open';

export interface FreeDSenderStats {
  /** Datagrams handed to the socket. */
  sent: number;
  /** Ticks skipped because the sample was incomplete. */
  skippedIncomplete: number;
  /** Ticks skipped because no sample had been supplied yet. */
  skippedNoSample: number;
  /** Socket errors seen since start. */
  errors: number;
}

export interface FreeDSender {
  /**
   * Replace the sample that the next tick will send. Cheap: it stores, it
   * does not transmit. The tick owns the wire.
   */
  update(sample: FreeDSample): void;
  /** Begin ticking. Calling it twice is a no-op, not a second timer. */
  start(): void;
  /** Stop ticking and close the socket. Safe to call when not started. */
  stop(): void;
  /**
   * Encode and send the current sample once, outside the tick. Returns what
   * happened, so a caller testing a route gets an answer instead of a guess.
   */
  sendNow(): { ok: true } | { ok: false; reason: SendeAbbruch };
  readonly stats: FreeDSenderStats;
  /** Milliseconds between ticks, derived from `rateHz`. */
  readonly intervalMs: number;
  readonly running: boolean;
}

export function createFreeDSender(options: FreeDSenderOptions): FreeDSender {
  const { host, port, rateHz } = options;
  if (!host) throw new Error('FreeD sender: host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`FreeD sender: port must be 1..65535, got ${String(port)}`);
  }
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    throw new Error(`FreeD sender: rateHz must be a positive number, got ${String(rateHz)}`);
  }

  const intervalMs = 1000 / rateHz;
  const stats: FreeDSenderStats = {
    sent: 0,
    skippedIncomplete: 0,
    skippedNoSample: 0,
    errors: 0,
  };

  let sample: FreeDSample | null = null;
  let socket: dgram.Socket | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const fail = (err: Error): void => {
    stats.errors += 1;
    options.onError?.(err);
  };

  const tick = (
    afterSend?: () => void,
  ): { ok: true } | { ok: false; reason: SendeAbbruch } => {
    if (!sample) {
      stats.skippedNoSample += 1;
      return { ok: false, reason: 'no-sample' };
    }
    const encoded = encodeFreeD(sample);
    if (!encoded.ok) {
      stats.skippedIncomplete += 1;
      options.onIncomplete?.(encoded.missing);
      return { ok: false, reason: 'incomplete' };
    }
    const sock = socket;
    if (!sock) {
      fail(new Error('FreeD sender: socket is not open'));
      return { ok: false, reason: 'not-open' };
    }
    sock.send(encoded.packet, port, host, (err) => {
      if (err) fail(err);
      afterSend?.();
    });
    stats.sent += 1;
    return { ok: true };
  };

  return {
    update(next: FreeDSample): void {
      sample = next;
    },
    start(): void {
      if (timer) return;
      socket = dgram.createSocket('udp4');
      socket.on('error', fail);
      timer = setInterval(tick, intervalMs);
      // The tick must not hold the process open: a bridge that is otherwise
      // finished should exit, not linger because tracking is still ticking.
      timer.unref?.();
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (socket) {
        try {
          socket.close();
        } catch {
          // Already closed — not worth an error, and not worth a counter.
        }
        socket = null;
      }
    },
    sendNow(): { ok: true } | { ok: false; reason: SendeAbbruch } {
      const opened = !socket;
      if (opened) {
        socket = dgram.createSocket('udp4');
        socket.on('error', fail);
      }
      // The socket closes only once the datagram is actually out. Closing
      // straight after `send()` returns would race the write and drop it —
      // the one-shot would report success and put nothing on the wire.
      const s = socket;
      const closeWhenDone = (): void => {
        if (!opened || timer || socket !== s || !s) return;
        socket = null;
        s.close();
      };
      const result = tick(closeWhenDone);
      if (!result.ok) closeWhenDone();
      return result;
    },
    stats,
    intervalMs,
    get running(): boolean {
      return timer !== null;
    },
  };
}
