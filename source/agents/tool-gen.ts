import type { AgentDefinition } from "./types.js";
import type { LLMProvider } from "../providers/types.js";
import type { AgavConfig } from "../config/config.js";

export interface ToolGenContext {
  toolName: string;
  toolDescription: string;
  agentName: string;
  agentDescription: string;
  agentSystemPrompt: string;
  credentials: string[];
  existingStub?: string;
}

export async function generateToolCode(
  provider: LLMProvider,
  config: AgavConfig,
  ctx: ToolGenContext
): Promise<string> {
  const credList = ctx.credentials.length > 0
    ? ctx.credentials.map((k) => `process.env.${k}`).join(", ")
    : "no credentials required";

  const basePrompt = ctx.existingStub
    ? `Re-implement this agav agent tool stub — replace every TODO and placeholder with a real implementation.

Agent: ${ctx.agentName} — ${ctx.agentDescription}
Credentials available: ${credList}

Current stub:
${ctx.existingStub}

Return the complete updated module. Use the real ${ctx.agentName} API. No TODOs, no placeholders.`
    : `Implement a JavaScript ES module (.mjs) for an agav agent tool.

Agent: ${ctx.agentName} — ${ctx.agentDescription}
Agent purpose: ${ctx.agentSystemPrompt.slice(0, 400)}

Tool name: ${ctx.toolName}
Tool description: ${ctx.toolDescription}
Credentials available: ${credList}

Required format (export this exact shape):
export default {
  schema: {
    name: "${ctx.toolName}",
    description: "...",
    inputSchema: { type: "object", properties: { /* all params */ }, required: [] }
  },
  async execute(input) {
    // real implementation using fetch() against the ${ctx.agentName} API
    // access credentials via process.env.CRED_KEY
    // return { output: string, isError: boolean }
    // format output as readable text, handle errors gracefully
  }
};

Use real API endpoints. No TODOs, no placeholders.`;

  let result = "";
  for await (const event of provider.stream({
    model: config.model,
    effort: "medium" as any,
    messages: [{ role: "user", content: [{ type: "text", text: basePrompt }] }],
    systemPrompt:
      "You are an expert JavaScript developer generating agav agent tool implementations. " +
      "Return ONLY the JavaScript code — no markdown fences, no explanation, no comments about what you changed.",
    tools: [],
  })) {
    if (event.type === "text_delta") result += event.text;
  }

  result = result.trim();
  if (result.startsWith("```")) {
    result = result.replace(/^```(?:javascript|js|mjs)?\r?\n/, "").replace(/\r?\n```$/, "");
  }
  return result;
}

export async function implementAgentTools(
  agent: AgentDefinition,
  provider: LLMProvider,
  config: AgavConfig,
  onStatus: (msg: string) => void,
): Promise<{ fixed: number }> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");

  onStatus("Reading tools...");
  const toolsDir = join(agent.path, agent.manifest["tools-dir"] || "tools");
  const credentials = agent.manifest["required-config"] ?? [];
  let fixed = 0;

  for (const tool of agent.tools) {
    // Reject tool names containing path separators to prevent directory traversal
    if (/[\/\\]/.test(tool.schema.name)) continue;

    const toolFile = join(toolsDir, `${tool.schema.name.replace(/_/g, "-")}.mjs`);
    let src: string;
    try { src = await readFile(toolFile, "utf-8"); } catch {
      try {
        const alt = join(toolsDir, `${tool.schema.name}.mjs`);
        src = await readFile(alt, "utf-8");
      } catch { continue; }
    }
    if (!src.includes("TODO")) continue;

    onStatus(`Implementing ${tool.schema.name}...`);
    const generated = await generateToolCode(provider, config, {
      toolName: tool.schema.name,
      toolDescription: tool.schema.description || `Tool for ${agent.manifest.name}`,
      agentName: agent.manifest.name,
      agentDescription: agent.manifest.description,
      agentSystemPrompt: agent.systemPrompt,
      credentials,
      existingStub: src,
    });

    if (generated) {
      // Structural validation: reject LLM output that doesn't look like a tool module
      if (!generated.includes("export") || !generated.includes("execute")) {
        onStatus(`Skipping ${tool.schema.name}: generated output does not look like a valid tool module`);
        continue;
      }

      let actualPath: string;
      try {
        await readFile(join(toolsDir, `${tool.schema.name.replace(/_/g, "-")}.mjs`), "utf-8");
        actualPath = join(toolsDir, `${tool.schema.name.replace(/_/g, "-")}.mjs`);
      } catch {
        actualPath = join(toolsDir, `${tool.schema.name}.mjs`);
      }
      await writeFile(actualPath, generated, "utf-8");
      fixed++;
    }
  }

  return { fixed };
}
