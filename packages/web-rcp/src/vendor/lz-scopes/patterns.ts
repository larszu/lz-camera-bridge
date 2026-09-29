// STUB, not the upstream file. lz-camera-bridge feeds the scopes from the
// bridge (`Source.connectFrames`) and never generates test patterns, so the
// upstream `patterns.ts` (and the images it references) are not vendored.
// `sources.ts` imports these two names; the stub keeps it byte-identical to
// upstream. See VENDOR.md.

export interface PatternDef {
  id: string;
  name: string;
  group: string;
  animated?: boolean;
  transfer?: 'pq' | 'hlg';
  src?: string;
  draw?: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void;
}

const NONE: PatternDef = { id: 'none', name: 'none', group: 'none' };

export function patternById(_id: string): PatternDef {
  return NONE;
}

export async function renderPattern(..._args: unknown[]): Promise<void> {
  throw new Error('Test patterns are not part of this build.');
}
