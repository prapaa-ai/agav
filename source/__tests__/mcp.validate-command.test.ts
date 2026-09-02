import { describe, expect, it } from "vitest";
import { validateMCPCommand } from "../mcp/client.js";

describe("validateMCPCommand", () => {
  it("allows safe commands", () => {
    expect(() => validateMCPCommand("npx", ["-y", "some-package"])).not.toThrow();
    expect(() => validateMCPCommand("node", ["server.js"])).not.toThrow();
    expect(() => validateMCPCommand("python", ["-m", "mcp_server"])).not.toThrow();
    expect(() => validateMCPCommand("C:\\Program Files\\node\\node.exe", [])).not.toThrow();
  });

  it("rejects commands with shell metacharacters", () => {
    expect(() => validateMCPCommand("cmd && whoami", [])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("node|evil", [])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("node;rm", [])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("$(whoami)", [])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("node`id`", [])).toThrow("unsafe characters");
  });

  it("rejects args with shell metacharacters", () => {
    expect(() => validateMCPCommand("node", ["--flag & whoami"])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("node", ["$(evil)"])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("node", ["arg1", "arg2|bad"])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("node", ["test\ninjection"])).toThrow("unsafe characters");
    expect(() => validateMCPCommand("node", ["test\rinjection"])).toThrow("unsafe characters");
  });

  it("rejects each individual metacharacter", () => {
    const metachars = ["&", "|", "<", ">", "^", ";", "`", "$", "(", ")", "{", "}", "[", "]", "!", "%", '"', "\n", "\r"];
    for (const char of metachars) {
      expect(() => validateMCPCommand(`cmd${char}bad`, []), `command with '${char}'`).toThrow("unsafe characters");
      expect(() => validateMCPCommand("cmd", [`arg${char}bad`]), `arg with '${char}'`).toThrow("unsafe characters");
    }
  });

  it("allows single quotes in paths (not a cmd.exe metacharacter)", () => {
    expect(() => validateMCPCommand("C:\\Users\\O'Brien\\node.exe", [])).not.toThrow();
    expect(() => validateMCPCommand("node", ["--name=O'Reilly"])).not.toThrow();
  });

  it("allows args with spaces, dots, slashes, and hyphens", () => {
    expect(() => validateMCPCommand("npx", ["-y", "@scope/package-name"])).not.toThrow();
    expect(() => validateMCPCommand("node", ["path/to/file.js"])).not.toThrow();
    expect(() => validateMCPCommand("python", ["-m", "my.module"])).not.toThrow();
    expect(() => validateMCPCommand("cmd", ["C:\\Users\\test\\file.txt"])).not.toThrow();
  });
});
