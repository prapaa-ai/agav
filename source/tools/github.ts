import { execFile } from "node:child_process";
import type { ToolDefinition, ToolResult } from "./types.js";

function run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        exitCode: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
      });
    });
  });
}

/** Validate that the gh CLI is installed and already authenticated. */
async function checkGh(): Promise<string | null> {
  const { exitCode, stderr } = await run(["auth", "status"]);
  if (exitCode !== 0) {
    return stderr.includes("not logged")
      ? "GitHub CLI is not authenticated. Run: gh auth login"
      : "GitHub CLI (gh) is not available. Install it from https://cli.github.com";
  }
  return null;
}

export const githubTool: ToolDefinition = {
  schema: {
    name: "github",
    description:
      "Interact with GitHub via the gh CLI. Supports creating/viewing PRs and issues. " +
      "Requires the gh CLI to be installed and authenticated.",
    // Not marked destructive — loop.ts handles non-SAFE_TOOLS confirmation.
    // This avoids blocking read-only operations like view_pr and list_prs.
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["create_pr", "view_pr", "list_prs", "create_issue", "view_issue", "list_issues"],
          description: "The GitHub operation to perform.",
        },
        title: {
          type: "string",
          description: "Title for the PR or issue (required for create operations).",
        },
        body: {
          type: "string",
          description: "Body/description for the PR or issue.",
        },
        base: {
          type: "string",
          description: "Base branch for the PR (defaults to the repo default branch).",
        },
        number: {
          type: "number",
          description: "PR or issue number (required for view operations).",
        },
      },
      required: ["operation"],
    },
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const authErr = await checkGh();
    if (authErr) return { output: authErr, isError: true };

    const op = String(input.operation ?? "");
    const title = String(input.title ?? "");
    const body = String(input.body ?? "");
    const base = String(input.base ?? "");
    const number = input.number ? String(input.number) : "";

    switch (op) {
      case "create_pr": {
        if (!title) return { output: "Title is required for creating a PR.", isError: true };
        const args = ["pr", "create", "--title", title];
        if (body) args.push("--body", body);
        if (base) args.push("--base", base);
        const result = await run(args);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "view_pr": {
        if (!number) return { output: "PR number is required.", isError: true };
        const result = await run(["pr", "view", number]);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "list_prs": {
        const result = await run(["pr", "list"]);
        return {
          output: result.stdout || result.stderr || "No open PRs.",
          isError: result.exitCode !== 0,
        };
      }

      case "create_issue": {
        if (!title) return { output: "Title is required for creating an issue.", isError: true };
        const args = ["issue", "create", "--title", title];
        if (body) args.push("--body", body);
        const result = await run(args);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "view_issue": {
        if (!number) return { output: "Issue number is required.", isError: true };
        const result = await run(["issue", "view", number]);
        return {
          output: result.stdout || result.stderr,
          isError: result.exitCode !== 0,
        };
      }

      case "list_issues": {
        const result = await run(["issue", "list"]);
        return {
          output: result.stdout || result.stderr || "No open issues.",
          isError: result.exitCode !== 0,
        };
      }

      default:
        return { output: `Unknown operation: ${op}`, isError: true };
    }
  },
};
