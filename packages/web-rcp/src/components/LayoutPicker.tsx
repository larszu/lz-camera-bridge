import React from 'react';
import { SWITCHER_LAYOUTS, mainWindow, type SwitcherLayout } from '../lib/layouts.ts';

interface Props {
  mode: number;
  /** window → source, to print the source number into each window. */
  outputs: Record<number, number>;
  onPick: (mode: number) => void;
  disabled?: boolean;
}

/** The twelve pictures of the VIS-CATC as clickable thumbnails. */
export function LayoutPicker({ mode, outputs, onPick, disabled }: Props) {
  return (
    <div className="layouts" role="radiogroup" aria-label="Output layout">
      {SWITCHER_LAYOUTS.map((l) => (
        <button
          key={l.mode}
          type="button"
          role="radio"
          aria-checked={l.mode === mode}
          className={`layout ${l.mode === mode ? 'layout--active' : ''}`}
          onClick={() => onPick(l.mode)}
          disabled={disabled}
          title={l.name}
        >
          <Thumb layout={l} outputs={outputs} />
          <span>{l.label} · {l.name}</span>
        </button>
      ))}
    </div>
  );
}

function Thumb({ layout, outputs }: { layout: SwitcherLayout; outputs: Record<number, number> }) {
  const pgm = mainWindow(layout.mode);
  return (
    <svg className="layout__thumb" viewBox="0 0 160 90" aria-hidden="true">
      {layout.windows.map((w) => (
        <g key={w.number}>
          <rect
            className={`layout__win ${w.number === pgm ? 'layout__win--pgm' : ''}`}
            x={(w.x / 100) * 160}
            y={(w.y / 100) * 90}
            width={(w.width / 100) * 160}
            height={(w.height / 100) * 90}
          />
          <text
            className="layout__txt"
            x={((w.x + w.width / 2) / 100) * 160}
            y={((w.y + w.height / 2) / 100) * 90 + 6}
            textAnchor="middle"
          >
            {outputs[w.number] ?? w.number}
          </text>
        </g>
      ))}
    </svg>
  );
}
