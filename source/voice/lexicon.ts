/**
 * Developer phonetic lexicon normalizer.
 * Post-processes speech-to-text outputs to correct common software engineering
 * acronyms, library names, and CLI commands mistranscribed by standard Whisper models.
 */

interface LexiconRule {
  pattern: RegExp;
  replacement: string;
}

const RULES: LexiconRule[] = [
  // Git commands and terms
  { pattern: /\b(?:get|git)\s+hub\b/gi, replacement: "GitHub" },
  { pattern: /\b(?:get|git)\s+lab\b/gi, replacement: "GitLab" },
  { pattern: /\bget\s+status\b/gi, replacement: "git status" },
  { pattern: /\bget\s+commit\b/gi, replacement: "git commit" },
  { pattern: /\bget\s+push\b/gi, replacement: "git push" },
  { pattern: /\bget\s+pull\b/gi, replacement: "git pull" },
  { pattern: /\bget\s+diff\b/gi, replacement: "git diff" },
  { pattern: /\bget\s+checkout\b/gi, replacement: "git checkout" },
  { pattern: /\bget\s+branch\b/gi, replacement: "git branch" },
  { pattern: /\bget\s+rebase\b/gi, replacement: "git rebase" },
  { pattern: /\bget\s+clone\b/gi, replacement: "git clone" },
  { pattern: /\bget\s+merge\b/gi, replacement: "git merge" },
  { pattern: /\bget\s+log\b/gi, replacement: "git log" },
  { pattern: /\bget\s+fetch\b/gi, replacement: "git fetch" },

  // Agav specific terms
  { pattern: /\ba[\s-]?(?:gav|gov)\b/gi, replacement: "agav" },

  // Programming languages and frameworks
  { pattern: /\btype[\s-]script\b/gi, replacement: "TypeScript" },
  { pattern: /\bjava[\s-]script\b/gi, replacement: "JavaScript" },
  { pattern: /\bnode[\s-]js\b/gi, replacement: "Node.js" },
  { pattern: /\bnext[\s-]js\b/gi, replacement: "Next.js" },
  { pattern: /\bvue[\s-]js\b/gi, replacement: "Vue.js" },
  { pattern: /\breact[\s-]js\b/gi, replacement: "React" },
  { pattern: /\bnuxt[\s-]js\b/gi, replacement: "Nuxt.js" },
  { pattern: /\bpie[\s-]?torch\b/gi, replacement: "PyTorch" },
  { pattern: /\btensor[\s-]?flow\b/gi, replacement: "TensorFlow" },
  { pattern: /\bpost[\s-]?grass\b/gi, replacement: "PostgreSQL" },
  { pattern: /\bpost[\s-]?gres(?:[\s-]?sql)?\b/gi, replacement: "PostgreSQL" },
  { pattern: /\bmongo[\s-]?db\b/gi, replacement: "MongoDB" },

  // Package managers and build tools
  { pattern: /\bp[\s-]npm\b/gi, replacement: "pnpm" },
  { pattern: /\bn[\s-]pm\b/gi, replacement: "npm" },
  { pattern: /\bvitest\b/gi, replacement: "vitest" },
  { pattern: /\bvee[\s-]?test\b/gi, replacement: "vitest" },

  // Cloud & DevOps
  { pattern: /\b(?:cube[\s-]?cuddle|cube[\s-]?control|cube[\s-]?c-t-l)\b/gi, replacement: "kubectl" },
  { pattern: /\bdocker[\s-]compose\b/gi, replacement: "docker compose" },
  { pattern: /\bkubernetes\b/gi, replacement: "Kubernetes" },
  { pattern: /\bterraform\b/gi, replacement: "Terraform" },

  // IDEs & AI
  { pattern: /\bv[\s-]?s[\s-]?code\b/gi, replacement: "VS Code" },
  { pattern: /\bopen[\s-]?ai\b/gi, replacement: "OpenAI" },
  { pattern: /\banthropic\b/gi, replacement: "Anthropic" },
  { pattern: /\bclaude[\s-]?sonnet\b/gi, replacement: "Claude Sonnet" },
  { pattern: /\bgroq\b/gi, replacement: "Groq" },
  { pattern: /\bollama\b/gi, replacement: "Ollama" },
];

/**
 * Normalizes speech-to-text text using developer lexicon rules.
 */
export function normalizeDeveloperLexicon(text: string): string {
  if (!text || typeof text !== "string") return "";

  let result = text;
  for (const rule of RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }

  // Normalize multi-whitespace
  result = result.replace(/[ \t]+/g, " ").trim();

  return result;
}
