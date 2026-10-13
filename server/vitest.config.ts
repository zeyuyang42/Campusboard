import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@bc/shared": path.resolve(__dirname, "../shared/src/types.ts") } },
  test: { include: ["test/**/*.test.ts"] },
});
