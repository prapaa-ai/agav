interface ToolMeta {
  label: string;
  formatSummary: (input: Record<string, unknown>) => string;
}

const TOOL_META: Record<string, ToolMeta> = {
  read_file: {
    label: "Read File",
    formatSummary: (input) => String(input.path ?? ""),
  },
  write_file: {
    label: "Write File",
    formatSummary: (input) => String(input.path ?? ""),
  },
  edit_file: {
    label: "Edit File",
    formatSummary: (input) => String(input.path ?? ""),
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
    formatSummary: (input) => String(input.path ?? "."),
  },
  web_search: {
    label: "Web Search",
    formatSummary: (input) => String(input.query ?? ""),
  },
  lsp_query: {
    label: "LSP Query",
    formatSummary: (input) => `${input.operation} ${input.path ?? ""}`,
  },
  read_notebook: {
    label: "Read Notebook",
    formatSummary: (input) => String(input.path ?? ""),
  },
  edit_notebook: {
    label: "Edit Notebook",
    formatSummary: (input) => `cell ${input.cell} in ${input.path ?? ""}`,
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
    formatSummary: (input) => String(input.path ?? "all tests"),
  },
  overview: {
    label: "Overview",
    formatSummary: (input) => String(input.path ?? "."),
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
  return (TOOL_META[name] ?? DEFAULT_META).label;
}

export function getToolSummary(
  name: string,
  input: Record<string, unknown>,
): string {
  return (TOOL_META[name] ?? DEFAULT_META).formatSummary(input);
}
