#!/usr/bin/env node
// Bundles a service entrypoint (TypeScript workspace sources) into one ESM file for its
// container image. Workspace packages are inlined via the "@orrery/source" export condition;
// third-party packages with native code or runtime file loading stay external and are
// installed in the image with `pnpm deploy --prod`.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: bundle.mjs <entry.ts> <out.js>");
  process.exit(2);
}

const EXTERNAL = [
  "@temporalio/*", // native core-bridge + webpack (workflow bundling)
  "@kubernetes/client-node",
  "@opentelemetry/*",
  "@langfuse/*",
  "pg",
  "pg-native",
  "pino",
  "pino-*",
  "thread-stream",
  "unpdf",
  "ws",
  "bufferutil",
  "utf-8-validate",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "@agentclientprotocol/sdk",
];

mkdirSync(path.dirname(path.resolve(outfile)), { recursive: true });
const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  conditions: ["@orrery/source"],
  mainFields: ["module", "main"],
  external: EXTERNAL,
  sourcemap: "linked",
  legalComments: "linked",
  metafile: true,
  logLevel: "warning",
  // CommonJS dependencies bundled into ESM still call require().
  banner: { js: "import { createRequire as __orreryCreateRequire } from 'node:module'; const require = __orreryCreateRequire(import.meta.url);" },
});
const bytes = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
console.log(`bundled ${entry} -> ${outfile} (${(bytes / 1024).toFixed(0)} KiB)`);
