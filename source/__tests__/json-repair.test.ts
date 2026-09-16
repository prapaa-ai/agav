import { describe, it, expect } from "vitest";
import { repairAndParseJson } from "../utils/json-repair.js";

describe("repairAndParseJson", () => {
  it("parses valid JSON without modification", () => {
    const raw = JSON.stringify({ path: "src/index.ts", line: 42 });
    expect(repairAndParseJson(raw)).toEqual({ path: "src/index.ts", line: 42 });
  });

  it("handles empty or whitespace-only input", () => {
    expect(repairAndParseJson("")).toEqual({});
    expect(repairAndParseJson("   \n\t  ")).toEqual({});
  });

  it("strips markdown code blocks", () => {
    const raw = "```json\n{\n  \"command\": \"npm test\"\n}\n```";
    expect(repairAndParseJson(raw)).toEqual({ command: "npm test" });
  });

  it("extracts JSON embedded within conversational text", () => {
    const raw = "Here is the tool call you requested:\n{\"path\": \"app.tsx\", \"content\": \"hello\"}\nHope this helps!";
    expect(repairAndParseJson(raw)).toEqual({ path: "app.tsx", content: "hello" });
  });

  it("removes trailing commas in objects and arrays", () => {
    const raw = "{\n  \"files\": [\"a.ts\", \"b.ts\",],\n  \"verbose\": true,\n}";
    expect(repairAndParseJson(raw)).toEqual({ files: ["a.ts", "b.ts"], verbose: true });
  });

  it("fixes single quotes in keys and string values", () => {
    const raw = "{ 'command': 'git status', 'cwd': './src' }";
    expect(repairAndParseJson(raw)).toEqual({ command: "git status", cwd: "./src" });
  });

  it("fixes unquoted object keys", () => {
    const raw = "{ path: \"README.md\", append: true }";
    expect(repairAndParseJson(raw)).toEqual({ path: "README.md", append: true });
  });

  it("heurstic fallback extracts key fields from severely malformed output", () => {
    const raw = "I am calling the tool with path: \"package.json\" and command: \"build\"";
    const res = repairAndParseJson(raw);
    expect(res["path"]).toBe("package.json");
    expect(res["command"]).toBe("build");
  });
});
