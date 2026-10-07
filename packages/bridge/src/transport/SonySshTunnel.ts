/**
 * SSH tunnel to a Sony camera with Access Authentication on.
 *
 * Sony Camera Control PTP 3 Reference, "Connection by SSH": SSH on port 22,
 * user/password from the camera's access-authentication settings, cipher
 * aes128-ctr, port forwarding to the camera's localhost:15740, no remote
 * commands. With SSH on, port 15740 is closed to the network. The host key
 * is checked against the fingerprint the camera shows under Access Authen.
 * Info. Measured on a real FX3 (fw 7.00): OpenSSH_7.9, aes128-ctr,
 * keyboard-interactive only.
 *
 * `ssh2` is optional like `usb`: without it this path reports so instead of
 * taking the bridge down.
 */
import { createHash } from 'crypto';
import type { ByteStream } from '../protocol/PtpIp.js';

export interface SshLogin {
  host: string;
  user: string;
  password: string;
  /** Confirmed fingerprint, "SHA256:…" or MD5 hex "aa:bb:…". */
  fingerprint?: string;
  /** Test hook; a camera always listens on 22. */
  port?: number;
  targetPort?: number;
}

export interface HostFingerprint {
  sha256: string;
  md5: string;
}

/** OpenSSH-style SHA256 fingerprint, plus the MD5 hex form. */
export function fingerprintsOf(key: Buffer): HostFingerprint {
  return {
    sha256: 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''),
    md5: (createHash('md5').update(key).digest('hex').match(/../g) ?? []).join(':'),
  };
}

/**
 * Thrown when the host key is not confirmed yet (`unknown`) or differs from
 * the confirmed one (`mismatch`). The message stays machine-readable for the
 * panel: "ssh-fingerprint-<kind> <sha256> <md5>".
 */
export class FingerprintError extends Error {
  constructor(readonly kind: 'unknown' | 'mismatch', readonly fp: HostFingerprint) {
    super(`ssh-fingerprint-${kind} ${fp.sha256} ${fp.md5}`);
  }
}

async function loadSsh2(): Promise<any | null> {
  try {
    const name = 'ssh2';
    const mod = await import(name);
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/** One SSH connection to a camera; hands out forwarded channels to its PTP/IP port. */
export class SonySshTunnel {
  private client: any = null;
  fingerprint: HostFingerprint | null = null;

  constructor(private readonly login: SshLogin) {}

  async connect(timeoutMs = 10000): Promise<HostFingerprint> {
    const ssh2 = await loadSsh2();
    if (!ssh2) throw new Error('SSH-Modul nicht installiert: npm install ssh2 --workspace=packages/bridge');
    const { host, user, password, fingerprint, port = 22 } = this.login;
    let refused: Error | null = null;
    this.client = await new Promise((resolve, reject) => {
      const c = new ssh2.Client();
      c.on('ready', () => resolve(c))
        .on('error', (e: Error) => reject(refused ?? e))
        .on('keyboard-interactive', (_n: string, _i: string, _l: string, prompts: unknown[], finish: (a: string[]) => void) =>
          finish(prompts.map(() => password)),
        )
        .connect({
          host,
          port,
          username: user,
          password,
          tryKeyboard: true,
          readyTimeout: timeoutMs,
          algorithms: { cipher: ['aes128-ctr'] },
          hostVerifier: (key: Buffer) => {
            this.fingerprint = fingerprintsOf(key);
            if (!fingerprint) refused = new FingerprintError('unknown', this.fingerprint);
            else if (fingerprint !== this.fingerprint.sha256 && fingerprint !== this.fingerprint.md5) {
              refused = new FingerprintError('mismatch', this.fingerprint);
            }
            return !refused;
          },
        });
    });
    return this.fingerprint!;
  }

  /** A forwarded channel to the camera's localhost:15740. */
  channel(): Promise<ByteStream> {
    return new Promise((resolve, reject) =>
      this.client.forwardOut('127.0.0.1', 0, 'localhost', this.login.targetPort ?? 15740, (err: Error | undefined, stream: ByteStream) =>
        err ? reject(err) : resolve(stream),
      ),
    );
  }

  close(): void {
    try {
      this.client?.end();
    } catch {
      /* already gone */
    }
    this.client = null;
  }
}
