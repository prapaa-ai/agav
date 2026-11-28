import { describe, expect, it } from "vitest";
import { parseGoTest } from "../tools/test-runner.js";

describe("tools/test-runner — parseGoTest", () => {
  it("includes failing Go subtest names without double-counting parent and child failures", () => {
    const output = [
      "=== RUN   TestParse",
      "=== RUN   TestParse/valid_input",
      "=== RUN   TestParse/invalid_input",
      "    parse_test.go:24: unexpected nil",
      "--- FAIL: TestParse (0.01s)",
      "    --- PASS: TestParse/valid_input (0.00s)",
      "    --- FAIL: TestParse/invalid_input (0.01s)",
      "=== RUN   TestFormat",
      "--- PASS: TestFormat (0.00s)",
      "FAIL",
    ].join("\n");

    const results = parseGoTest(output);

    expect(results.framework).toBe("go test");
    expect(results.passed).toBe(1);
    expect(results.failed).toBe(1);
    expect(results.failures.map((f) => f.test)).toEqual([
      "TestParse",
      "TestParse/invalid_input",
    ]);
    for (const failure of results.failures) {
      expect(failure.error).toContain("parse_test.go:24: unexpected nil");
      expect(failure.error).not.toContain("--- PASS:");
    }
  });

  it("handles deeply nested failing subtests while keeping top-level counts", () => {
    const output = [
      "--- FAIL: TestSuite (0.02s)",
      "    --- FAIL: TestSuite/group (0.01s)",
      "        --- FAIL: TestSuite/group/edge_case (0.01s)",
    ].join("\n");

    const results = parseGoTest(output);

    expect(results.passed).toBe(0);
    expect(results.failed).toBe(1);
    expect(results.failures).toEqual([
      { test: "TestSuite", error: "Test failed" },
      { test: "TestSuite/group", error: "Test failed" },
      { test: "TestSuite/group/edge_case", error: "Test failed" },
    ]);
  });
});
