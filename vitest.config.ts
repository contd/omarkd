import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
    css: { include: /.+/ },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: { perFile: true, functions: 100, statements: 95, lines: 95, branches: 85 },
    },
  },
});
