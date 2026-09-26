import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkA2AExecutionApproval } from "../agents/a2a-approval.js";
import type { AgentDefinition } from "../agents/types.js";
import * as registryModule from "../agents/agent-registry.js";

// Mock the registry module
vi.mock("../agents/agent-registry.js", () => {
  return {
    loadRegistry: vi.fn(),
    saveRegistry: vi.fn(),
    acquireRegistryLock: vi.fn().mockResolvedValue(() => {}),
  };
});

describe("checkA2AExecutionApproval", () => {
  let mockRegistry: any;

  beforeEach(() => {
    mockRegistry = { agents: {} };
    vi.mocked(registryModule.loadRegistry).mockResolvedValue(mockRegistry);
    vi.mocked(registryModule.saveRegistry).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should return false and not prompt if confirmTool is not provided", async () => {
    const agent = { alias: "test-agent", manifest: { name: "test", "start-command": "foo" } } as unknown as AgentDefinition;
    
    // Silence console.error for this test
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    
    const result = await checkA2AExecutionApproval(agent);
    
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("should prompt the user and return false if denied", async () => {
    const agent = { alias: "test-agent", manifest: { name: "test", "start-command": "foo" } } as unknown as AgentDefinition;
    const confirmTool = vi.fn().mockResolvedValue("no");

    const result = await checkA2AExecutionApproval(agent, confirmTool);
    
    expect(result).toBe(false);
    expect(confirmTool).toHaveBeenCalledWith("A2A Process Execution: test-agent", { "start-command": "foo" });
  });

  it("should return true if user answers 'yes' (but not save to registry)", async () => {
    const agent = { alias: "test-agent", manifest: { name: "test", "start-command": "foo" } } as unknown as AgentDefinition;
    const confirmTool = vi.fn().mockResolvedValue("yes");

    const result = await checkA2AExecutionApproval(agent, confirmTool);
    
    expect(result).toBe(true);
    expect(registryModule.saveRegistry).not.toHaveBeenCalled();
  });

  it("should return true, save to registry, and record the start-command if user answers 'always'", async () => {
    mockRegistry.agents["test-agent"] = { name: "test", enabled: true, installedAt: "", version: "1" };
    
    const agent = { alias: "test-agent", manifest: { name: "test", "start-command": "foo" } } as unknown as AgentDefinition;
    const confirmTool = vi.fn().mockResolvedValue("always");

    const result = await checkA2AExecutionApproval(agent, confirmTool);
    
    expect(result).toBe(true);
    expect(registryModule.saveRegistry).toHaveBeenCalled();
    expect(mockRegistry.agents["test-agent"].approvedExecution).toBe(true);
    expect(mockRegistry.agents["test-agent"].approvedStartCommand).toBe("foo");
  });

  it("should return true immediately without prompting if already approved with matching command", async () => {
    mockRegistry.agents["test-agent"] = { 
      name: "test", 
      enabled: true, 
      installedAt: "", 
      version: "1",
      approvedExecution: true,
      approvedStartCommand: "foo"
    };
    
    const agent = { alias: "test-agent", manifest: { name: "test", "start-command": "foo" } } as unknown as AgentDefinition;
    const confirmTool = vi.fn();

    const result = await checkA2AExecutionApproval(agent, confirmTool);
    
    expect(result).toBe(true);
    expect(confirmTool).not.toHaveBeenCalled();
  });

  it("should invalidate trust and prompt again if start-command has changed", async () => {
    // Previously approved for "foo"
    mockRegistry.agents["test-agent"] = { 
      name: "test", 
      enabled: true, 
      installedAt: "", 
      version: "1",
      approvedExecution: true,
      approvedStartCommand: "foo"
    };
    
    // Now agent manifest wants to run "bar"
    const agent = { alias: "test-agent", manifest: { name: "test", "start-command": "bar" } } as unknown as AgentDefinition;
    const confirmTool = vi.fn().mockResolvedValue("yes");

    const result = await checkA2AExecutionApproval(agent, confirmTool);
    
    // Should prompt because the command changed from foo to bar
    expect(confirmTool).toHaveBeenCalledWith("🚨 SECURITY WARNING: test-agent", { 
      "start-command": "bar",
      "WARNING": "The start command was changed from what you previously approved (\"foo\")."
    });
    expect(result).toBe(true);
  });
});
