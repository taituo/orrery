#!/usr/bin/env node
// Pre-builds the Temporal workflow bundle at image build time so workers start instantly and
// every replica runs byte-identical workflow code (required for deterministic replay).
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(path.resolve("package.json"));
const { bundleWorkflowCode } = require("@temporalio/worker");
const pkgJson = require.resolve("@orrery/workflows/package.json");
const entry = path.join(path.dirname(pkgJson), "src", "index.ts");
const out = path.resolve(process.argv[2] ?? "dist/workflow-bundle.js");

const { code } = await bundleWorkflowCode({
  workflowsPath: entry,
  webpackConfigHook: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.conditionNames = ["@orrery/source", "import", "module", "require", "default"];
    config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
    return config;
  },
});
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, code);
console.log(`workflow bundle -> ${out} (${(code.length / 1024).toFixed(0)} KiB)`);
