# T09 — build/release integration notes for the supervisor entry asset

Scope note: this delivery pass intentionally does **not** edit
`package.json`, the `build` script, or any CI/release workflow files. T11
(`source/background-jobs/supervisor/entry.ts`) does not exist yet in this
pass, so there is nothing new to wire into packaging yet. This document
records exactly what to check/do once T11 lands, so a future pass does not
have to re-derive it.

## Conclusion: no `build` script change is needed

Checked `tsconfig.json`:

```json
{
  "compilerOptions": {
    "outDir": "build",
    "rootDir": "./source",
    ...
  },
  "include": ["source"],
  "exclude": ["node_modules", "build", "**/*.kt", "**/*.kts"]
}
```

`include` covers the whole `source` directory (no narrower glob), and
`source/background-jobs/**/*.ts` is already inside `source/`. Since
`rootDir` is `./source` and `outDir` is `build`, the ordinary `tsc` compile
step that `pnpm build` already runs (`tsc` with no extra flags, see
`package.json`'s `build` script) will — for free, with no additional
copy/wiring step — emit:

```
source/background-jobs/packaging/locator.ts   -> build/background-jobs/packaging/locator.js
source/background-jobs/packaging/manifest.ts  -> build/background-jobs/packaging/manifest.js
source/background-jobs/supervisor/entry.ts    -> build/background-jobs/supervisor/entry.js   (once T11 adds it)
```

This is the same reason the existing `build` script does **not** have any
explicit copy step for e.g. `source/skills/loader.ts` or
`source/agents/loader.ts` — they are plain `.ts` files under `source/` and
`tsc` already compiles them in place under `build/`. The explicit
`copyFileSync`/`cpSync` lines in `package.json`'s `build` script exist only
for assets `tsc` does NOT know how to produce:

- `source/cli.tsx -> build/cli.js` — verbatim copy of an already-built(?)
  entry wrapper (not compiled by this invocation of `tsc` the same way).
- `source/agents/bundled`, `source/skills/bundled` — non-`.ts` data/asset
  directories (agent/skill definitions), not TypeScript source.
- `source/agents/sandbox-exec.mjs` — a hand-written plain `.mjs` file that
  lives under `source/` but is intentionally NOT a `.ts` file (so `tsc`
  does not touch it) and must therefore be copied verbatim to sit next to
  its compiled sibling modules at runtime.

The future T11 supervisor entry is the opposite case: it will be an
ordinary `.ts` file (e.g. `source/background-jobs/supervisor/entry.ts`),
so — unlike `sandbox-exec.mjs` — it does NOT need a verbatim-copy line.
`tsc` already compiles it automatically because it is inside `source/`,
which `tsconfig.json`'s `include` already covers.

## What *would* need a build script change (and currently does not apply)

If T11's supervisor entry ever needs a non-`.ts` sibling asset (for example,
a native addon, a prebuilt binary, or a hand-written `.mjs`/`.cjs` file that
`tsc` must not try to parse — analogous to `sandbox-exec.mjs`), then
`package.json`'s `build` script would need one additional line following
the existing precedent, e.g.:

```sh
node -e "require('fs').copyFileSync('source/background-jobs/supervisor/<asset>','build/background-jobs/supervisor/<asset>')"
```

or, for a whole directory of non-`.ts` assets:

```sh
node -e "require('fs').cpSync('source/background-jobs/supervisor/<dir>','build/background-jobs/supervisor/<dir>',{recursive:true})"
```

`WINDOWS_HELPER_ASSETS` in `manifest.ts` is intentionally empty for this
delivery (see T04's handoff — no native Windows Job Object helper binary is
bundled), so there is currently no native-helper asset that would require
such a copy line either. If a future pass adds a real native helper binary,
it should be listed in `WINDOWS_HELPER_ASSETS` AND given a corresponding
copy line in the `build` script at that time — both changes should land
together.

## Action item for whoever lands T11

1. Add `source/background-jobs/supervisor/entry.ts` (plain TypeScript,
   NodeNext ESM, relative imports use `.js` extensions per this repo's
   convention).
2. Run `pnpm build` and confirm `build/background-jobs/supervisor/entry.js`
   is produced — no `package.json` edit should be required for this file
   itself, per the analysis above.
3. Only touch `package.json`'s `build` script if a non-`.ts` sibling asset
   (native binary, hand-written `.mjs`, etc.) is introduced alongside
   `entry.ts`; in that case add exactly one copy line modeled on the
   `sandbox-exec.mjs` line shown above.
