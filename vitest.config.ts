import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts", "plugins/*/tests/**/*.test.ts"], environment: "node" },
});
