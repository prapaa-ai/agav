import { EventEmitter } from "node:events";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import render from "../ink/render.js";
import type { ResourceItem } from "../resources/types.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  props: undefined as undefined | { actions: { key: string; run(item: ResourceItem | undefined): unknown }[] },
}));
vi.mock("../resources/adapters.js", () => ({
  createResourceAdapter: () => ({ create: mocks.create }),
  createSkillsMarketplaceAdapter: () => ({}),
}));
vi.mock("../components/resource-manager.js", () => ({
  ResourceManager: (props: NonNullable<typeof mocks.props>) => { mocks.props = props; return null; },
}));
import { SkillsTUI } from "../components/skills-tui.js";

describe("skills marketplace installation action", () => {
  it("passes marketplace identity before installation and preserves the returned status", async () => {
    const stdout = new EventEmitter() as NodeJS.WriteStream;
    Object.assign(stdout, { isTTY: true, columns: 100, rows: 24, write: () => true });
    const stdin = new EventEmitter() as NodeJS.ReadStream;
    Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, resume: () => stdin, pause: () => stdin, read: () => null });
    const instance = render(h(SkillsTUI, { onExit: vi.fn() }), { stdout, stdin, patchConsole: false, exitOnCtrlC: false });
    try {
      await instance.waitUntilRenderFlush();
      const install = mocks.props!.actions.find((action) => action.key === "a")!;
      const status = "Installed PDF Tools.\nSupporting assets were not installed.";
      mocks.create.mockResolvedValue(status);
      expect(await install.run({ id: "https://skill", title: "PDF Tools", description: "", detail: "" })).toBe(status);
      expect(mocks.create).toHaveBeenCalledWith({ source: "https://skill", name: "PDF Tools" });
      await install.run(undefined);
      expect(mocks.create).toHaveBeenCalledOnce();
    } finally { instance.unmount(); }
  });
});
