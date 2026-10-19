import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests for the player wiring (store, persistence, mini bridge). The audio elements are
// FakeAudio (test/fakeAudio.ts), the core is an in-memory stub and timers are fake: no
// network, no database, no sound.
export default defineConfig({
  resolve: { alias: { "@bc/core": path.resolve(__dirname, "../packages/core/src/index.ts") } },
  test: { include: ["test/**/*.test.ts"], environment: "happy-dom", setupFiles: ["test/setup.ts"] },
});
