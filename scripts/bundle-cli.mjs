#!/usr/bin/env node
// Builds the CLI into one dependency-free file (Node 20+): apps/cli/dist/orrery.mjs.
// The web image serves it at /cli/orrery.mjs, so every install hands out a matching CLI.
import { build } from "esbuild";
import { chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "apps/cli/dist/orrery.mjs");
await build({
  entryPoints: [path.join(root, "apps/cli/src/main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  conditions: ["@orrery/source"],
  banner: { js: "#!/usr/bin/env node" },
  legalComments: "none",
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.log(`bundled CLI -> ${path.relative(process.cwd(), outfile)}`);
