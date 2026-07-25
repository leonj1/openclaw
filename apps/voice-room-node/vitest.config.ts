import { defineConfig } from "vitest/config";
import path from "node:path";

const rootDir = path.resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: {
      "@openclaw/gateway-client": path.resolve(
        rootDir,
        "../../packages/gateway-client/src",
      ),
      "@openclaw/gateway-protocol": path.resolve(
        rootDir,
        "../../packages/gateway-protocol/src",
      ),
    },
    conditions: ["import", "default"],
  },
  test: {
    root: ".",
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/*.e2e.test.ts",
      "**/*.live.test.ts",
      "src/gateway/connect.test.ts",
    ],
    testTimeout: 5000,
  },
});
