import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@bc/core": path.resolve(__dirname, "src/index.ts") } },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
