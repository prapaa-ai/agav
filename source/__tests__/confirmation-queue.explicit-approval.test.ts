import { describe, expect, it } from "vitest";
import { ConfirmationQueue } from "../agent/confirmation-queue.js";

describe("explicit-only confirmations", () => {
  it("does not auto-accept an explicit approval after blanket Always is enabled", async () => {
    const queue = new ConfirmationQueue();
    let shown: any;
    queue.bind((item) => { shown = item; });

    const blanketApproval = queue.enqueue({ toolName: "write_file", input: {} });
    queue.resolve("always");
    await expect(blanketApproval).resolves.toBe("always");

    const explicit = queue.enqueue({ toolName: "run_command", input: {}, explicitApprovalOnly: true });
    expect(shown).toMatchObject({ toolName: "run_command", explicitApprovalOnly: true });
    queue.resolve("yes");
    await expect(explicit).resolves.toBe("yes");
  });

  it("does not let an explicit-only confirmation accept Always or widen it", async () => {
    const queue = new ConfirmationQueue();
    let shown: any;
    queue.bind((item) => { shown = item; });

    const explicit = queue.enqueue({ toolName: "run_command", input: {}, explicitApprovalOnly: true });
    const following = queue.enqueue({ toolName: "write_file", input: {} });

    expect(queue.resolve("always")).toBe("no");
    await expect(explicit).resolves.toBe("no");
    expect(shown).toMatchObject({ toolName: "write_file" });

    queue.resolve("no");
    await expect(following).resolves.toBe("no");
    const later = queue.enqueue({ toolName: "edit_file", input: {} });
    expect(shown).toMatchObject({ toolName: "edit_file" });
    queue.resolve("no");
    await expect(later).resolves.toBe("no");
  });

  it("downgrades Always to a one-shot yes when the org floor requires confirmation", async () => {
    // Under an org floor of "ask", approving the first tool with "Always" must
    // NOT flip the queue to blanket auto-accept: the next tool must still prompt.
    const queue = new ConfirmationQueue();
    let shown: any;
    queue.bind((item) => { shown = item; });
    queue.setPermissionFloor("ask");

    const first = queue.enqueue({ toolName: "write_file", input: {} });
    expect(queue.resolve("always")).toBe("yes");
    await expect(first).resolves.toBe("yes");

    // A second request is displayed (not silently auto-approved).
    const second = queue.enqueue({ toolName: "edit_file", input: {} });
    expect(shown).toMatchObject({ toolName: "edit_file" });
    queue.resolve("no");
    await expect(second).resolves.toBe("no");
  });

  it("rejects Always for an explicit-only approval even when an org floor downgrades blanket approvals", async () => {
    const queue = new ConfirmationQueue();
    queue.bind(() => {});
    queue.setPermissionFloor("ask");

    const explicit = queue.enqueue({ toolName: "subagent_model", input: {}, explicitApprovalOnly: true });
    expect(queue.resolve("always")).toBe("no");
    await expect(explicit).resolves.toBe("no");
  });

  it("still allows blanket Always when the floor permits auto-accept (or no floor)", async () => {
    const queue = new ConfirmationQueue();
    queue.bind(() => {});
    queue.setPermissionFloor("auto-accept");

    const first = queue.enqueue({ toolName: "write_file", input: {} });
    queue.resolve("always");
    await expect(first).resolves.toBe("always");
    // Blanket auto-accept is in effect: a later request resolves without a prompt.
    await expect(queue.enqueue({ toolName: "edit_file", input: {} })).resolves.toBe("always");
  });

  it("does not let another confirmation's Always resolve a queued explicit approval", async () => {
    const queue = new ConfirmationQueue();
    let shown: any;
    queue.bind((item) => { shown = item; });

    const blanket = queue.enqueue({ toolName: "write_file", input: {} });
    const explicit = queue.enqueue({ toolName: "run_command", input: {}, explicitApprovalOnly: true });
    const other = queue.enqueue({ toolName: "edit_file", input: {} });

    queue.resolve("always");
    await expect(blanket).resolves.toBe("always");
    await expect(other).resolves.toBe("always");
    expect(shown).toMatchObject({ toolName: "run_command", explicitApprovalOnly: true });

    queue.resolve("yes");
    await expect(explicit).resolves.toBe("yes");
  });
});
