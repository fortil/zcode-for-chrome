import { build } from "esbuild";
import { cp } from "node:fs/promises";

const common = {
  bundle: true,
  // chrome120 para que esbuild no envuelva los await de las funciones que se
  // inyectan con executeScript en helpers externos (D9): esas funciones se
  // serializan con toString() y no pueden referenciar nada de fuera.
  target: "chrome120",
  minify: false,
  sourcemap: false,
  logLevel: "info",
};

// El service worker se carga como módulo (manifest background.type=module);
// offscreen y popup son páginas normales.
await build({ ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js", format: "esm" });
await build({ ...common, entryPoints: ["src/offscreen.ts"], outfile: "dist/offscreen.js", format: "iife" });
await build({ ...common, entryPoints: ["src/popup.ts"], outfile: "dist/popup.js", format: "iife" });

await cp("public", "dist", { recursive: true });
