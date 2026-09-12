import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["source/**/*.test.ts", "source/**/__tests__/**/*.test.ts"],
    // Bound the worker pool. Vitest defaults to one fork per CPU core, and each
    // fork is a full Node process that can reserve a multi-GB V8 heap. On a
    // high-core dev machine that meant ~10 heavy processes; interrupted or
    // repeated runs left them orphaned and pushed the machine into swap.
    //
    // We stay on the `forks` pool (not `threads`) because several tests call
    // `process.chdir()`, which throws inside worker threads. Capping `maxForks`
    // bounds peak memory while keeping enough parallelism for a fast run.
    pool: "forks",
    poolOptions: {
      forks: {
        // Keep parallelism useful without spawning one heavy fork per core.
        maxForks: 4,
        // Don't hold idle forks warm between files.
        minForks: 1,
      },
    },
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
