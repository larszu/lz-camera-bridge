// Line icons in the brand set (lzm-web): 1.5 px stroke, square caps,
// monochrome in the text colour. Paths after Lucide (ISC), corners squared.

const PATHS = {
  video: 'M16 13l6 4V7l-6 4M2 6h14v12H2z',
  gamepad: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M2 6h20v12H2z',
  sliders: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4',
  settings: 'M20 7h-9M14 17H5M14 4v6M10 14v6',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M12 3a6 6 0 0 0 9 9a9 9 0 1 1-9-9z',
  auto: 'M3 4h18v12H3zM8 20h8M12 16v4',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, label }: { name: IconName; size?: number; label?: string }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
