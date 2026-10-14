// Signet "lz." from the brand kit (Brand Guide 2.0). Never altered, never
// rounded. Colours only from the kit: the letters take `--logo` (Navy on
// light, Off-White on dark), the dot is always the Tally signal. Both come
// from CSS (`.logo__mark`, `.logo__dot`), so the SVG carries no colour.
export function Logo({ height = 32 }: { height?: number }) {
  return (
    <svg
      className="logo"
      viewBox="478.129 455.570 234.046 139.875"
      height={height}
      width={(height * 234.046) / 139.875}
      role="img"
      aria-label="Lars Zumpe Medienproduktion"
    >
      <path
        className="logo__mark"
        d="M478.129 595.445L505.285 455.570H540.207L513.047 595.445ZM638.277 595.445L555.828 595.445L561.062 568.285L610.922 521.727L570.183 521.727L575.422 494.566L657.871 494.566L652.633 521.727L602.773 568.285L643.515 568.285Z"
      />
      <path className="logo__dot" d="M677.011 595.445 681.538 565.865H712.175L707.647 595.445Z" />
    </svg>
  );
}
