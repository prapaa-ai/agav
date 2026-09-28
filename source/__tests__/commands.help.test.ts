import { describe, expect, it } from "vitest";

import { createHelpCommand } from "../commands/help.js";
import { MID_TURN_SAFE_COMMANDS } from "../commands/mid-turn.js";
import type { SlashCommand } from "../commands/types.js";

const commands: SlashCommand[] = [...MID_TURN_SAFE_COMMANDS].map((name) => ({
  name,
  description: `${name} command`,
  async execute() {
    return { type: "message", text: name };
  },
}));

describe("commands/help", () => {
  it("lists commands that can run while Agav is working", async () => {
    const helpCommand = createHelpCommand(() => commands);

    const result = await helpCommand.execute("", {} as any);

    expect(result.type).toBe("message");
    if (result.type !== "message") throw new Error("expected message result");
    expect(result.text).toContain("While Agav is working:");
    for (const name of MID_TURN_SAFE_COMMANDS) {
      expect(result.text).toContain(`/${name}`);
    }
  });
});
