import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const launchState = vi.hoisted(() => ({
  isChangelogAutoDisplayEnabled: vi.fn<() => Promise<boolean>>(),
  setChangelogAutoDisplay: vi.fn<(enabled: boolean) => Promise<boolean>>(),
}));
const autoUpdate = vi.hoisted(() => ({ getChangelog: vi.fn<() => Promise<string>>() }));

vi.mock("../config/launch-state.js", () => launchState);
vi.mock("../utils/auto-update.js", () => autoUpdate);

const { changelogCommand } = await import("../commands/changelog.js");
const context = {} as CommandContext;

beforeEach(() => {
  vi.resetAllMocks();
});

describe("/changelog status", () => {
  it.each([
    { enabled: true, expected: /is enabled/ },
    { enabled: false, expected: /is disabled/ },
  ])("reports the saved preference when enabled is $enabled", async ({ enabled, expected }) => {
    launchState.isChangelogAutoDisplayEnabled.mockResolvedValue(enabled);
    const result = await changelogCommand.execute(" Status ", context);
    expect(result).toEqual({ type: "message", text: expect.stringMatching(expected) });
    expect(autoUpdate.getChangelog).not.toHaveBeenCalled();
    expect(launchState.setChangelogAutoDisplay).not.toHaveBeenCalled();
  });

  it("lists status in the usage for an unknown option", async () => {
    const result = await changelogCommand.execute("later", context);
    expect(result).toEqual({ type: "message", text: 'Unknown option "later". Usage: /changelog [on|off|status]' });
    expect(changelogCommand.usage).toContain("/changelog status");
  });
});
