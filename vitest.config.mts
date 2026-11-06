import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "lib/**/*.test.ts"],
    env: { API_KEY_PEPPER: "test-pepper-0123456789abcdef" },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
