import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assetBaseUrls } from "../utils/auto-update.js";

// `agav update` / `agav update <version>` resolve release assets through
// assetBaseUrls: the Cloudflare mirror first, GitHub second, so a self-update
// uses the same primary+fallback origins as the shell installers. GitHub must
// always remain in the list as the independent fallback, and AGAV_MIRROR_BASE
// must both override the mirror and (when empty) disable it.

const GITHUB = "https://github.com/prapaa-ai/agav/releases/download";
const DEFAULT_MIRROR = "https://releases.agav.dev";

describe("assetBaseUrls (agav update origin order)", () => {
  const saved = process.env.AGAV_MIRROR_BASE;

  beforeEach(() => {
    delete process.env.AGAV_MIRROR_BASE;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.AGAV_MIRROR_BASE;
    else process.env.AGAV_MIRROR_BASE = saved;
  });

  it("tries the Cloudflare mirror first, then GitHub", () => {
    expect(assetBaseUrls("v0.2.1")).toEqual([
      `${DEFAULT_MIRROR}/v0.2.1`,
      `${GITHUB}/v0.2.1`,
    ]);
  });

  it("works for a pinned version tag too (agav update <version>)", () => {
    expect(assetBaseUrls("v0.2.1-beta.8")).toEqual([
      `${DEFAULT_MIRROR}/v0.2.1-beta.8`,
      `${GITHUB}/v0.2.1-beta.8`,
    ]);
  });

  it("always keeps GitHub as the last (fallback) origin", () => {
    const urls = assetBaseUrls("v1.0.0");
    expect(urls[urls.length - 1]).toBe(`${GITHUB}/v1.0.0`);
  });

  it("honors an AGAV_MIRROR_BASE override, mirror still first", () => {
    process.env.AGAV_MIRROR_BASE = "https://mirror.example.com";
    expect(assetBaseUrls("v0.2.1")).toEqual([
      "https://mirror.example.com/v0.2.1",
      `${GITHUB}/v0.2.1`,
    ]);
  });

  it("uses GitHub only when AGAV_MIRROR_BASE is empty", () => {
    process.env.AGAV_MIRROR_BASE = "";
    expect(assetBaseUrls("v0.2.1")).toEqual([`${GITHUB}/v0.2.1`]);
  });
});
