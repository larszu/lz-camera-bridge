// ESM resolve-hook: laesst `node --experimental-strip-types` extensionslose
// relative Imports (`./paintState`) aufloesen, indem `.ts` ergaenzt
// wird. Node's Strip-Types-Modus loest Extensions nicht selbst auf; der
// Vite/tsc-Build (moduleResolution: bundler) schon. Nur fuer die Check-Skripte,
// beruehrt keinen Produktionscode.
export async function resolve(specifier, context, next) {
  if (specifier[0] === '.' && !/\.\w+$/.test(specifier)) {
    try {
      return await next(specifier + '.ts', context);
    } catch {
      /* faellt unten auf die Default-Aufloesung zurueck */
    }
  }
  return next(specifier, context);
}
