# LZ Scopes (vendored)

Source: [larszu/lz-scopes](https://github.com/larszu/lz-scopes) (private), `src/`, commit `fd1b5fd` on `main`.

| File | State |
|---|---|
| `color.ts`, `renderer.ts`, `graticule.ts`, `panel.ts`, `sources.ts`, `embed.ts` | byte-identical to upstream |
| `index.ts` | upstream minus the `PATTERNS`/`RESOLUTIONS`/`renderPattern` export |
| `patterns.ts` | **stub**, not upstream: the bridge never generates test patterns, and the upstream file references images under `patterns/lz-display/` that are not copied. It only exists so `sources.ts` stays unchanged. |

Not vendored: `main.ts`, `output.ts`, `boot.ts`, `style.css` (the standalone app) and `server/` (the bridge side lives in `packages/bridge/src/multiview/ScopeStream.ts` and speaks the same frame protocol, `docs/frame-protocol.md` upstream).

## Local rules

- Do not edit these files. The German labels of upstream are replaced at runtime in `components/ScopePanel.tsx` (`SCOPE_LABELS`, source messages), and the 3 px panel radius is overridden in `index.css`.
- `scripts/quellsprache-check.mjs` skips `src/vendor/`.
- The files typecheck under this package's `tsconfig.json` as they are; if a future upstream version does not, add an exception for this folder rather than rewriting the code.

## Sync

```bash
UP=~/Projekte/lz-scopes            # checkout of larszu/lz-scopes
DST=packages/web-rcp/src/vendor/lz-scopes
git -C $UP log -1 --format=%h      # note the commit for the table above
for f in color renderer graticule panel sources embed; do cp $UP/src/$f.ts $DST/; done
diff <(grep -v -e PATTERNS -e '^//' $UP/src/index.ts) <(grep -v '^//' $DST/index.ts)   # new exports?
npx tsc --noEmit -p packages/web-rcp && npm run build --workspace=packages/web-rcp
```

If `sources.ts` starts importing more from `patterns.ts`, extend the stub.
