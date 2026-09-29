import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { scopeUrl } from '../hooks/useBridge.ts';
import { SCOPE_LABELS, ScopeView, Source, type ScopeType } from '../vendor/lz-scopes/index.ts';

/**
 * Waveform, vectorscope, parade, histogram for one camera — LZ Scopes
 * (vendored, `vendor/lz-scopes/VENDOR.md`) on the bridge's `/scope/<n>`.
 *
 * The bridge decodes the camera's stream to raw R'G'B' with its own ffmpeg
 * for as long as this panel is mounted; unmounting closes the socket and the
 * bridge kills that ffmpeg. The MJPEG picture of the tile is a separate path
 * and is not measured — a JPEG would re-quantise the levels.
 *
 * The vendored code is German-labelled upstream and stays byte-identical, so
 * the visible words are replaced here instead of in the copy.
 */
Object.assign(SCOPE_LABELS, {
  picture: 'Picture',
  parade: 'RGB parade',
  yrgb: 'YRGB parade',
  ycbcr: 'YCbCr parade',
  hist: 'Histogram',
  stats: 'Readouts',
} satisfies Partial<Record<ScopeType, string>>);

const RETRY_MS = 4000;

type Status = Source['status'];

function englishMessage(src: Source): string {
  if (src.status === 'connecting') return 'Connecting…';
  if (src.status === 'ended' && /^Verbindung/.test(src.message)) return 'Connection closed.';
  if (src.status === 'error' && /^Bridge nicht/.test(src.message)) return 'Bridge not reachable.';
  return src.message;
}

interface Props {
  cameraNumber: number;
  scopes: ScopeType[];
  title?: string;
  onClose: () => void;
  /** Present on the inline panel: opens the four-scope view. */
  onExpand?: () => void;
  className?: string;
}

export function ScopePanel({ cameraNumber, scopes, title, onClose, onExpand, className }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ state: Status; message: string }>({ state: 'connecting', message: 'Connecting…' });
  const [rate, setRate] = useState({ fps: 0, dropped: 0 });
  // The scope choice lives in the view (its panel selects); a new array from
  // the parent must not tear down the stream.
  const initialScopes = useRef(scopes);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let view: ScopeView;
    try {
      view = new ScopeView(el, { scopes: initialScopes.current, emptyText: 'No signal' });
    } catch {
      el.replaceChildren();
      setStatus({ state: 'error', message: 'This browser cannot draw the scopes: WebGL2 with float render targets is required.' });
      return;
    }
    const src = new Source('stream', `CAM ${cameraNumber}`);
    const url = scopeUrl(cameraNumber);
    let retry: ReturnType<typeof setTimeout> | null = null;
    src.onChange = () => {
      src.message = englishMessage(src);
      setStatus({ state: src.status, message: src.message });
      if ((src.status === 'error' || src.status === 'ended') && !retry) {
        retry = setTimeout(() => { retry = null; src.connectFrames(url); }, RETRY_MS);
      }
    };
    src.connectFrames(url);
    view.setSource(src);
    const tick = setInterval(() => setRate({ fps: src.fps, dropped: src.dropped }), 1000);
    return () => {
      clearInterval(tick);
      if (retry) clearTimeout(retry);
      src.onChange = () => {};
      src.stop();
      view.destroy();
    };
  }, [cameraNumber]);

  return (
    <div className={`scopes ${className ?? ''}`} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <div className="scopes__bar">
        <span className="scopes__title">{title ?? `CAM ${cameraNumber}`}</span>
        <span className={`scopes__status scopes__status--${status.state}`}>
          {status.message}
          {status.state === 'live' && ` · ${rate.fps} fps`}
          {status.state === 'live' && rate.dropped > 0 && ` · ${rate.dropped} dropped`}
        </span>
        {onExpand && (
          <button className="btn btn--sm" onClick={onExpand} title="Waveform, vectorscope, parade and histogram, full window">
            4 scopes
          </button>
        )}
        <button className="btn btn--sm" onClick={onClose} aria-label="Close scopes">
          Close
        </button>
      </div>
      <div className="scopes__view" ref={host} />
    </div>
  );
}

/** The four-scope view over the whole window. Esc closes it. */
export function ScopeOverlay({ cameraNumber, title, onClose }: { cameraNumber: number; title?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="scopes-overlay" role="dialog" aria-label={`Scopes ${title ?? ''}`}>
      <ScopePanel
        cameraNumber={cameraNumber}
        title={title}
        scopes={['wf-luma', 'vector', 'parade', 'hist']}
        onClose={onClose}
        className="scopes--full"
      />
    </div>,
    document.body,
  );
}
