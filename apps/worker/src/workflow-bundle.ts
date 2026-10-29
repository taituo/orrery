import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

/**
 * Workflow code runs in Temporal's deterministic sandbox. In production the bundle is built at
 * image build time (scripts/bundle-workflows.mjs) and loaded from disk; in development it is
 * bundled from TypeScript sources on startup.
 */
export async function workflowBundle(): Promise<{ workflowBundle: { codePath: string } } | { workflowBundle: WorkflowBundleWithSourceMap }> {
  const prebuilt = process.env.WORKFLOW_BUNDLE_PATH ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "workflow-bundle.js");
  if (existsSync(prebuilt)) return { workflowBundle: { codePath: prebuilt } };
  return { workflowBundle: await bundleWorkflows() };
}

export async function bundleWorkflows(): Promise<WorkflowBundleWithSourceMap> {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("@orrery/workflows/package.json");
  const entry = path.join(path.dirname(pkgJson), "src", "index.ts");
  return bundleWorkflowCode({
    workflowsPath: entry,
    webpackConfigHook: (config) => {
      config.resolve = config.resolve ?? {};
      config.resolve.conditionNames = ["@orrery/source", "import", "module", "require", "default"];
      // NodeNext-style ".js" specifiers point at ".ts" sources.
      config.resolve.extensionAlias = { ".js": [".ts", ".js"] };
      return config;
    },
  });
}
