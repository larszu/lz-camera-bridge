/**
 * b4-capture — read captures from the B4 interface and say what they show.
 *
 * The bench step of issues #43, #45 and #47, as a command:
 *
 *   npx tsx src/tools/b4Capture.ts idle.bin:idle zoom-tele.bin:zoom iris.bin:iris
 *
 * Each argument is `file[:operated[,operated…]]` — the raw bytes from
 * `GET /api/capture.bin` (or a logic analyser export as binary) and what was
 * operated while it was recorded; no label means idle. The FIRST capture is
 * the baseline. For every capture the report gives the frames by code, the
 * decoder's drop counters, the lens name if 0x11/0x12 answers are in it, and
 * against the baseline the codes that appeared and the widest monotonic field
 * — and a candidate assignment only when exactly one control was operated and
 * exactly one code moved (`candidateAssignment`, deliberately conservative).
 *
 * It decides nothing. It prints evidence for a person to write into
 * docs/b4/measurements/.
 */
import { readFileSync } from 'node:fs';
import { B4FrameDecoder, decodeLensName } from '../protocol/B4Lens.js';
import { behaviourByCode, candidateAssignment, diffCaptures, type B4Capture } from '../protocol/B4CaptureDiff.js';

export interface CaptureInput {
  label: string;
  operated: string[];
  bytes: Uint8Array;
}

const hex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

/** The lens name from 0x11/0x12 answers, joined per b4-lens-control.md §5, or null. */
export function lensNameIn(capture: B4Capture): string | null {
  let first: Buffer | null = null;
  for (const f of capture.frames) {
    if (f.cmd === 0x11 && f.data.length > 0) {
      first = f.data;
      if (f.data.length < 15) return decodeLensName(f.data) || null;
    } else if (f.cmd === 0x12 && first && first.length === 15) {
      return decodeLensName(first, f.data) || null;
    }
  }
  return first ? decodeLensName(first) || null : null;
}

export function report(inputs: readonly CaptureInput[]): string {
  if (inputs.length === 0) return 'No captures given.';
  const out: string[] = [];
  const captures: B4Capture[] = inputs.map((i) => {
    const dec = new B4FrameDecoder();
    const frames = dec.push(i.bytes);
    const s = dec.stats();
    out.push(`== ${i.label}  (operated: ${i.operated.length ? i.operated.join(', ') : 'nothing'})`);
    out.push(`   ${i.bytes.length} bytes, ${s.framesDecoded} frames, ${s.crcErrors} CRC errors, ` +
      `${s.lengthErrors} length errors, ${s.bytesDropped} bytes dropped, ${dec.pending} pending`);
    const cap: B4Capture = { label: i.label, operated: i.operated, frames };
    for (const b of behaviourByCode(cap).values()) {
      out.push(`   ${hex(b.cmd)}  ×${b.count}  len ${b.dataLen ?? 'varies'}`);
    }
    const name = lensNameIn(cap);
    if (name) out.push(`   lens name: "${name}"`);
    if (frames.length === 0 && i.bytes.length > 0) {
      out.push('   no valid frame: wrong baud rate, missing inversion, or not a group B line');
    }
    return cap;
  });

  const base = captures[0]!;
  for (const c of captures.slice(1)) {
    const d = diffCaptures(base, c);
    out.push(`-- ${c.label} against ${base.label}`);
    out.push(`   new codes: ${d.newCodes.map(hex).join(' ') || 'none'};  gone: ${d.goneCodes.map(hex).join(' ') || 'none'}`);
    for (const b of [...d.newBehaviour, ...d.changed]) {
      const f = b.monotonic[0];
      if (f) out.push(`   ${hex(b.cmd)} byte ${f.offset} (${f.width * 8} bit) ${f.direction} ${f.min}→${f.max}, span ${f.span}`);
    }
    const cand = candidateAssignment(d);
    out.push(cand
      ? `   CANDIDATE: ${cand.control} ↔ ${hex(cand.cmd)} (${cand.evidence}); confirm with the opposite direction`
      : '   no single candidate — not exactly one control operated, or not exactly one code moved');
  }
  return out.join('\n');
}

export function parseArg(arg: string): { file: string; label: string; operated: string[] } {
  const i = arg.lastIndexOf(':');
  const file = i > 0 ? arg.slice(0, i) : arg;
  const ops = i > 0 ? arg.slice(i + 1).split(',').map((s) => s.trim()).filter((s) => s && s !== 'idle') : [];
  return { file, label: file.replace(/^.*\//, ''), operated: ops };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: b4Capture.ts idle.bin[:idle] action.bin:<control> …  (first = baseline)');
    process.exit(2);
  }
  console.log(report(args.map((a) => {
    const p = parseArg(a);
    return { label: p.label, operated: p.operated, bytes: readFileSync(p.file) };
  })));
}
