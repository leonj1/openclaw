// Vitest project for the apps/voice-room-node device node.
//
// This app lives outside the pnpm workspace and owns its own deps (see
// apps/voice-room-node/AGENTS.md), so its tests run in a dedicated shard instead
// of the core src/** unit lanes. Keeping it isolated means app-local native deps
// (onnxruntime-node) never have to resolve inside a core unit run. Honors the
// harness include-file so `pnpm test apps/voice-room-node/<file>` scopes to just
// the requested test rather than the whole app tree.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadPatternListFromEnv } from "./vitest.pattern-file.ts";
import { sharedVitestConfig } from "./vitest.shared.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const includeFromEnv = loadPatternListFromEnv("OPENCLAW_VITEST_INCLUDE_FILE");

export default defineConfig({
  root: repoRoot,
  // Borrow the shared `@openclaw/*` source aliases so the node can import
  // `@openclaw/gateway-client` (and its gateway-protocol deps) by package name.
  // The app is outside the pnpm workspace, so those packages are not linked
  // under node_modules; the aliases point imports at the package `src/`. Only
  // the alias list is reused — the app shard keeps its isolated test settings.
  resolve: { alias: sharedVitestConfig.resolve.alias },
  test: {
    name: "apps-voice-room",
    include: includeFromEnv ?? ["apps/voice-room-node/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.live.test.ts", "**/*.e2e.test.ts"],
    environment: "node",
  },
});
