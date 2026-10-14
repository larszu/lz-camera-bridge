/**
 * JPEG ↔ raw RGB through the same ffmpeg the video tiles use (RtspHub.ts) —
 * the bridge carries no image library, and ffmpeg is already a requirement
 * for any live picture, which a panorama scan needs anyway.
 */
import { spawn } from 'child_process';
import { ffmpegCandidates } from '../multiview/RtspHub.js';
import type { RgbImage } from './stitch.js';

export interface JpegCodec {
  decode(jpeg: Buffer, width: number): Promise<RgbImage>;
  encode(image: RgbImage): Promise<Buffer>;
}

/** Width and height from a JPEG's SOF segment, or null when it is not a JPEG. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** One ffmpeg run with stdin → stdout; tries the candidates in order when one is missing. */
async function run(args: string[], input: Buffer, candidates = ffmpegCandidates()): Promise<Buffer> {
  let lastError: Error | null = null;
  for (const binary of candidates) {
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const out: Buffer[] = [];
        let err = '';
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(out));
          else reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited (${code})`));
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
    } catch (e) {
      lastError = e as Error;
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  throw lastError ?? new Error('ffmpeg not found');
}

export const ffmpegCodec: JpegCodec = {
  async decode(jpeg, width) {
    const size = jpegSize(jpeg);
    if (!size) throw new Error('The camera picture is not a JPEG');
    const w = Math.min(width, size.width);
    const h = Math.max(2, Math.round((w * size.height) / size.width / 2) * 2);
    const data = await run(['-f', 'jpeg_pipe', '-i', 'pipe:0', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], jpeg);
    if (data.length !== w * h * 3) throw new Error(`ffmpeg returned ${data.length} bytes for ${w}×${h}`);
    return { width: w, height: h, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
  },
  async encode(image) {
    return run(
      ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${image.width}x${image.height}`, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      Buffer.from(image.data.buffer, image.data.byteOffset, image.data.length),
    );
  },
};
