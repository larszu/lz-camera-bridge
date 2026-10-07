/**
 * Sony camera discovery on the network — Sony Camera Control PTP 3
 * Reference, "Device Discovery": SSDP M-SEARCH for
 * urn:schemas-sony-com:service:DigitalImaging:1, then dd.xml and
 * DigitalImagingDesc.xml for model, serial, firmware and whether the camera
 * wants SSH (Access Authentication) or pairing.
 *
 * Searches on every IPv4 interface — Wi-Fi, a cable, a hotspot bridge — not
 * only the default route. Answered by a real FX3 (fw 7.00) on 2026-10-07.
 */
import dgram from 'dgram';
import { networkInterfaces } from 'os';

export const SONY_SSDP_ST = 'urn:schemas-sony-com:service:DigitalImaging:1';

export interface SonyNetDevice {
  ip: string;
  /** Device name set in the camera. */
  name: string;
  model: string;
  /** Short serial from DigitalImagingDesc.xml (tail of the PTP serial). */
  serial: string;
  firmware: string;
  mac: string;
  /** Access Authentication on: PTP/IP only through SSH. */
  ssh: boolean;
  /** Access Authentication off: the camera asks once to pair. */
  pairing: boolean;
}

const tag = (xml: string, name: string): string => new RegExp(`<${name}>([^<]*)<`).exec(xml)?.[1] ?? '';

/** Read the two description files of one camera. Exported for tests. */
export function parseSonyDescription(ip: string, dd: string, desc: string): SonyNetDevice {
  return {
    ip,
    name: tag(dd, 'friendlyName'),
    model: tag(desc, 'X_ModelName') || tag(dd, 'friendlyName') || 'Sony',
    serial: tag(desc, 'X_SerialVersion'),
    firmware: tag(desc, 'X_FirmwareVersion'),
    mac: tag(desc, 'X_MacAddress'),
    ssh: tag(desc, 'X_SSH_Support') === 'Enable',
    pairing: /^(Necessary|Enable)$/.test(tag(desc, 'X_PTP_PairingNecessity')),
  };
}

async function describe(ip: string, location: string): Promise<SonyNetDevice | null> {
  try {
    const dd = await (await fetch(location, { signal: AbortSignal.timeout(3000) })).text();
    const scpd = tag(dd, 'SCPDURL') || '/DigitalImagingDesc.xml';
    const desc = await (await fetch(new URL(scpd, location), { signal: AbortSignal.timeout(3000) })).text();
    return parseSonyDescription(ip, dd, desc);
  } catch {
    return null;
  }
}

function localAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/** Search for `ms` milliseconds; resolves with every Sony camera that answered. */
export function discoverSonyNetCameras(ms = 2500): Promise<SonyNetDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Promise<SonyNetDevice | null>>();
    const sockets: dgram.Socket[] = [];
    const query = ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${SONY_SSDP_ST}`, '', ''].join('\r\n');
    for (const address of localAddresses()) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(sock);
      sock.on('error', () => {});
      sock.on('message', (msg, rinfo) => {
        const text = msg.toString();
        if (!text.includes('DigitalImaging')) return;
        const loc = /LOCATION:\s*(\S+)/i.exec(text)?.[1];
        if (loc && !found.has(rinfo.address)) found.set(rinfo.address, describe(rinfo.address, loc));
      });
      sock.bind(0, address, () => {
        try {
          sock.setMulticastInterface(address);
        } catch {
          /* interface without multicast */
        }
        for (const d of [0, 400, 1200]) setTimeout(() => sock.send(query, 1900, '239.255.255.250', () => {}), d);
      });
    }
    setTimeout(async () => {
      for (const s of sockets) {
        try {
          s.close();
        } catch {
          /* already closed */
        }
      }
      resolve((await Promise.all(found.values())).filter((d): d is SonyNetDevice => !!d));
    }, ms);
  });
}
