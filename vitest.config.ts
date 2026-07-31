import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["source/**/*.test.ts", "source/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["source/**/*.{ts,tsx}"],
      exclude: [
        "source/**/*.test.ts",
        "source/**/__tests__/**",
        "source/**/*.d.ts",
        "source/types.d.ts",
      ],
    },
  },
});
