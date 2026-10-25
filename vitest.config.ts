import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/ts/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
