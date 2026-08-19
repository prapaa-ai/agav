import { projectRelativePath, terminalRelativePaths, toolPathValues } from "./display-path.js";

interface ToolMeta {
  label: string;
  formatSummary: (input: Record<string, unknown>) => string;
}

const TOOL_META: Record<string, ToolMeta> = {
  read_file: {
    label: "Read File",
    formatSummary: (input) => projectRelativePath(String(input.path ?? "")),
  },
  write_file: {
    label: "Write File",
    formatSummary: (input) => projectRelativePath(String(input.path ?? "")),
  },
  edit_file: {
    label: "Edit File",
    formatSummary: (input) => projectRelativePath(String(input.path ?? "")),
  },
  run_command: {
    label: "Shell",
    formatSummary: (input) => {
      const cmd = String(input.command ?? "");
      return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
    },
  },
  grep_search: {
    label: "Search",
    formatSummary: (input) => {
      const p = String(input.pattern ?? "");
      const inc = input.include ? ` (${input.include})` : "";
      return p + inc;
    },
  },
  find_files: {
    label: "Find Files",
    formatSummary: (input) => String(input.pattern ?? ""),
  },
  list_directory: {
    label: "List Directory",
    formatSummary: (input) => projectRelativePath(String(input.path ?? ".")),
  },
  web_search: {
    label: "Web Search",
    formatSummary: (input) => String(input.query ?? ""),
  },
  lsp_query: {
    label: "LSP Query",
    formatSummary: (input) => `${input.operation} ${projectRelativePath(String(input.path ?? ""))}`,
  },
  read_notebook: {
    label: "Read Notebook",
    formatSummary: (input) => projectRelativePath(String(input.path ?? "")),
  },
  edit_notebook: {
    label: "Edit Notebook",
    formatSummary: (input) => `cell ${input.cell} in ${projectRelativePath(String(input.path ?? ""))}`,
  },
  fetch_url: {
    label: "Fetch URL",
    formatSummary: (input) => String(input.url ?? ""),
  },
  update_plan: {
    label: "Update Plan",
    formatSummary: (input) => `step ${input.step} → ${input.status}`,
  },
  image: {
    label: "Image",
    formatSummary: () => "",
  },
  run_tests: {
    label: "Tests",
    formatSummary: (input) => input.path ? projectRelativePath(String(input.path)) : "all tests",
  },
  overview: {
    label: "Overview",
    formatSummary: (input) => projectRelativePath(String(input.path ?? ".")),
  },
  github: {
    label: "GitHub",
    formatSummary: (input) => String(input.operation ?? ""),
  },
  subagent: {
    label: "Subagent",
    formatSummary: (input) => {
      const title = String(input.title ?? "");
      if (title) return title;
      const task = String(input.task ?? "");
      return task.length > 50 ? task.slice(0, 50) + "..." : task;
    },
  },
};

const DEFAULT_META: ToolMeta = {
  label: "Tool",
  formatSummary: (input) => {
    const keys = Object.keys(input);
    return keys.length > 0 ? keys.join(", ") : "";
  },
};

export function getToolLabel(name: string): string {
  if (TOOL_META[name]) return TOOL_META[name].label;
  // Named agent tools (e.g. "win_cua_agent" → "win-cua agent")
  if (name.endsWith("_agent")) {
    const agentName = name.slice(0, -6).replace(/_/g, "-");
    return `${agentName} agent`;
  }
  // Agent sub-tools with namespace prefix (e.g. "wincua_run_powershell" → "Run PowerShell")
  // Strip the prefix (everything up to and including the first underscore after a namespace)
  const prefixMatch = name.match(/^[a-z]+_(.+)$/);
  if (prefixMatch) {
    const rest = prefixMatch[1].replace(/_/g, " ");
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return DEFAULT_META.label;
}

export function getToolSummary(
  name: string,
  input: Record<string, unknown>,
): string {
  if (name.endsWith("_agent") && typeof input.task === "string") {
    const task = input.task as string;
    return task.length > 60 ? task.slice(0, 60) + "..." : task;
  }
  const summary = (TOOL_META[name] ?? DEFAULT_META).formatSummary(input);
  return terminalRelativePaths(summary, toolPathValues(input));
}
