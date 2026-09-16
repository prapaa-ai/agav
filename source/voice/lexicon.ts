/**
 * Lexical normalization and acoustic token filtering for Agav's native voice engine.
 *
 * Provides specialized technical terminology normalization for developer speech
 * and filtering for acoustic artifacts, hallucinations, and prompt token regurgitation.
 */

// ============================================================================
// Technical Term Normalization Patterns
// ============================================================================

interface ReplacementRule {
  pattern: RegExp;
  replacement: string;
}

// 1. Compound policies & algorithms (must run before isolated acronyms)
const COMPOUND_RULES: ReplacementRule[] = [
  { pattern: /\ball[\s\-_]?keys?[\s\-_]+lru\b/gi, replacement: "allkeys-lru" },
  { pattern: /\ball[\s\-_]?keys?[\s\-_]+random\b/gi, replacement: "allkeys-random" },
  { pattern: /\ball[\s\-_]?keys?[\s\-_]+lfu\b/gi, replacement: "allkeys-lfu" },
  { pattern: /\bvolatile[\s\-_]+lru(?:[\s\-_]+(?:pvi|pv))?\b/gi, replacement: "volatile-lru" },
  { pattern: /\bvolatile[\s\-_]+ttl\b/gi, replacement: "volatile-ttl" },
  { pattern: /\bvolatile[\s\-_]+random\b/gi, replacement: "volatile-random" },
  { pattern: /\bvolatile[\s\-_]+lfu\b/gi, replacement: "volatile-lfu" },
  { pattern: /\bthundering[\s\-_]+(?:hard|hurt|heard|herd)\b/gi, replacement: "thundering herd" },
  { pattern: /\b(?:to\s+)?catch\s+a?[\s\-_]*stampede\b/gi, replacement: "cache stampede" },
  { pattern: /\bcache[\s\-_]+stampede\b/gi, replacement: "cache stampede" },
  { pattern: /\b(?:r[\s\-_]*a[\s\-_]*f[\s\-_]*t|raft)[\s\-_]+consensus\b/gi, replacement: "Raft consensus" },
  { pattern: /\bpaxos\b/gi, replacement: "Paxos" },
  { pattern: /\braft\b/gi, replacement: "Raft" },
];

// 2. Systems & Developer Tools (phonetic misrecognitions and canonical casing)
const SYSTEM_TOOL_RULES: ReplacementRule[] = [
  // Redis (raditz / radice / radius / reddis -> Redis)
  { pattern: /\b(?:raditz|radice|radius|reddis|raddis|redis)\b/gi, replacement: "Redis" },
  // Kubernetes (cubernetis / koobernetes -> Kubernetes)
  { pattern: /\b(?:cubernetis|koobernetes|kuber[\s\-_]*netes|kubernetes|k8s)\b/gi, replacement: "Kubernetes" },
  // Kafka (kafca / kaphka -> Kafka)
  { pattern: /\b(?:kafca|kaphka|kafka)\b/gi, replacement: "Kafka" },
  // PostgreSQL (postgress / postgre sql / postgres -> PostgreSQL)
  { pattern: /\b(?:postgress|postgre[\s\-_]+sql|postgres|postgresql)\b/gi, replacement: "PostgreSQL" },
  // MongoDB
  { pattern: /\b(?:mongo[\s\-_]*db|mongodb)\b/gi, replacement: "MongoDB" },
  // GraphQL (grafql -> GraphQL)
  { pattern: /\b(?:grafql|graph[\s\-_]*ql|graphql)\b/gi, replacement: "GraphQL" },
  // gRPC
  { pattern: /\b(?:g[\s\-_]*rpc|grpc)\b/gi, replacement: "gRPC" },
  // FastAPI
  { pattern: /\b(?:fast[\s\-_]+api|fastapi)\b/gi, replacement: "FastAPI" },
  // Docker
  { pattern: /\bdocker\b/gi, replacement: "Docker" },
  // Nginx (engine x / n jinx -> Nginx)
  { pattern: /\b(?:engine[\s\-_]*x|engin[\s\-_]*x|n[\s\-_]*jinx|nginx)\b/gi, replacement: "Nginx" },
  // SQLite
  { pattern: /\b(?:sq[\s\-_]*lite|sequel[\s\-_]*lite|sqllite|sqlite)\b/gi, replacement: "SQLite" },
  // PyTorch (pie torch -> PyTorch)
  { pattern: /\b(?:pie[\s\-_]*torch|pi[\s\-_]*torch|pytorch)\b/gi, replacement: "PyTorch" },
  // TensorFlow
  { pattern: /\b(?:tensor[\s\-_]*flow|tensorflow)\b/gi, replacement: "TensorFlow" },
  // LangChain
  { pattern: /\b(?:lang[\s\-_]*chain|langchain)\b/gi, replacement: "LangChain" },
  // Neural net models & augmentation
  { pattern: /\btime[\s\-_]+test[\s\-_]+(?:augmenting|augmentation)\b/gi, replacement: "test-time augmentation (TTA)" },
  { pattern: /\bnet[\s\-_]+b0\b/gi, replacement: "EfficientNet-B0" },
  { pattern: /\befficient[\s\-_]+net\b/gi, replacement: "EfficientNet" },
  // Indexing features
  { pattern: /\b(?:h[\s\-_]*n[\s\-_]*s[\s\-_]*w|hnsw)[\s\-_]+indexing\b/gi, replacement: "HNSW indexing" },
  { pattern: /\b(?:jinn|gin)[\s\-_]+indexing\b/gi, replacement: "GIN indexing" },
  { pattern: /\bjinn[\s\-_]+index(?:es)?\b/gi, replacement: "GIN index" },
  // LeetCode (leat code -> LeetCode)
  { pattern: /\b(?:leat[\s\-_]*code|lead[\s\-_]*code|leet[\s\-_]*code|leetcode)\b/gi, replacement: "LeetCode" },
  // NeetCode
  { pattern: /\b(?:neat[\s\-_]*code|neatcode|neet[\s\-_]*code|neetcode)\b/gi, replacement: "NeetCode" },
  // Codeforces
  { pattern: /\b(?:code[\s\-_]*forces|codeforces)\b/gi, replacement: "Codeforces" },
  // Dijkstra
  { pattern: /\b(?:dijkstra|dijkstras|dijkstra's|deekstra|dykstra|dike[\s\-_]*stra)\b/gi, replacement: "Dijkstra" },
  // Data structures & algorithms
  { pattern: /\b(?:hash[\s\-_]*map|hashmap)\b/gi, replacement: "HashMap" },
  { pattern: /\b(?:order[\s\-_]+of[\s\-_]+one|big[\s\-_]+o[\s\-_]+of[\s\-_]+one)\b/gi, replacement: "O(1)" },
  { pattern: /\b(?:order[\s\-_]+of[\s\-_]+n|big[\s\-_]+o[\s\-_]+of[\s\-_]+n)\b/gi, replacement: "O(N)" },
  { pattern: /\b(?:order[\s\-_]+of[\s\-_]+log[\s\-_]+n|big[\s\-_]+o[\s\-_]+of[\s\-_]+log[\s\-_]+n)\b/gi, replacement: "O(log N)" },
  { pattern: /\btwo[\s\-_]+pointers?\b/gi, replacement: "Two Pointers" },
  { pattern: /\bsliding[\s\-_]+windows?\b/gi, replacement: "Sliding Window" },
  { pattern: /\bdynamic[\s\-_]+programming\b/gi, replacement: "Dynamic Programming" },
  // Distributed systems & databases
  { pattern: /\bcap[\s\-_]+theorem\b/gi, replacement: "CAP theorem" },
  { pattern: /\bacid[\s\-_]+properties\b/gi, replacement: "ACID properties" },
  { pattern: /\bconsistent[\s\-_]+hashing\b/gi, replacement: "Consistent Hashing" },
  { pattern: /\brate[\s\-_]+limit(?:er|ing)?\b/gi, replacement: "Rate Limiter" },
  { pattern: /\bcircuit[\s\-_]+breaker\b/gi, replacement: "Circuit Breaker" },
  { pattern: /\b(?:dynamo[\s\-_]*db|dynamodb)\b/gi, replacement: "DynamoDB" },
  // Conversational transitions & Hinglish developer code-switching
  { pattern: /\bcar[\s\-_]+in[\s\-_]+gay\b/gi, replacement: "karenge" },
  { pattern: /\bkarenga\b/gi, replacement: "karenge" },
  { pattern: /\bho[\s\-_]+jaega\b/gi, replacement: "ho jayega" },
  { pattern: /\bkar[\s\-_]+sakte[\s\-_]+hain\b/gi, replacement: "kar sakte hain" },
  { pattern: /\bkaise[\s\-_]+kareyn\b/gi, replacement: "kaise karein" },
  { pattern: /\bkarna[\s\-_]+hai\b/gi, replacement: "karna hai" },
  { pattern: /\bkar[\s\-_]+do\b/gi, replacement: "kar do" },
  { pattern: /\bkar[\s\-_]+dena\b/gi, replacement: "kar dena" },
  { pattern: /\bchal[\s\-_]+nahi[\s\-_]+raha\b/gi, replacement: "chal nahi raha" },
  { pattern: /\bconnect[\s\-_]+nahi[\s\-_]+ho[\s\-_]+raha\b/gi, replacement: "connect nahi ho raha" },
  { pattern: /\berror[\s\-_]+aa[\s\-_]+raha[\s\-_]+hai\b/gi, replacement: "error aa raha hai" },
  { pattern: /\bbug[\s\-_]+solve[\s\-_]+kar\b/gi, replacement: "bug solve kar" },
  { pattern: /\btest[\s\-_]+run[\s\-_]+karo\b/gi, replacement: "test run karo" },
  { pattern: /\bpush[\s\-_]+kar[\s\-_]+do\b/gi, replacement: "push kar do" },
  { pattern: /\bmerge[\s\-_]+kar[\s\-_]+do\b/gi, replacement: "merge kar do" },
  { pattern: /\bdeploy[\s\-_]+kar[\s\-_]+do\b/gi, replacement: "deploy kar do" },
  { pattern: /\brevert[\s\-_]+back\b/gi, replacement: "revert" },
  { pattern: /\bdo[\s\-_]+one[\s\-_]+thing\b/gi, replacement: "do one thing" },
];

// 3. Technical Acronyms (isolated or spaced phonetics, with lookbehind to preserve compound policies)
const ACRONYM_RULES: ReplacementRule[] = [
  // JSONB
  { pattern: /\b(?:json[\s\-_]*b|jsonb)\b/gi, replacement: "JSONB" },
  // CI/CD
  { pattern: /\b(?:c[\s\-_]*i[\s\-_]*[\/\\][\s\-_]*c[\s\-_]*d|c[\s\-_]*i[\s\-_]+c[\s\-_]*d|ci\/cd|cicd)\b/gi, replacement: "CI/CD" },
  // JWT
  { pattern: /\b(?:j[\s\-_]*w[\s\-_]*t|jwt)\b/gi, replacement: "JWT" },
  // LRU (protect against already normalized allkeys-lru / volatile-lru)
  { pattern: /(?<!(?:allkeys|volatile)[-_])\b(?:l[\s\-_]*r[\s\-_]*u|lru)\b/gi, replacement: "LRU" },
  // MRU
  { pattern: /\b(?:m[\s\-_]*r[\s\-_]*u|mru)\b/gi, replacement: "MRU" },
  // LFU (protect against already normalized allkeys-lfu / volatile-lfu)
  { pattern: /(?<!(?:allkeys|volatile)[-_])\b(?:l[\s\-_]*f[\s\-_]*u|lfu)\b/gi, replacement: "LFU" },
  // TTL (protect against already normalized volatile-ttl)
  { pattern: /(?<!volatile[-_])\b(?:t[\s\-_]*t[\s\-_]*l|ttl)\b/gi, replacement: "TTL" },
  // TTFT
  { pattern: /\b(?:t[\s\-_]*t[\s\-_]*f[\s\-_]*t|ttft)\b/gi, replacement: "TTFT" },
  // SLA
  { pattern: /\b(?:s[\s\-_]*l[\s\-_]*a|sla)\b/gi, replacement: "SLA" },
  // SLO
  { pattern: /\b(?:s[\s\-_]*l[\s\-_]*o|slo)\b/gi, replacement: "SLO" },
  // TTA
  { pattern: /\bt[\s\-_]*t[\s\-_]*a\b/gi, replacement: "TTA" },
  // CPU
  { pattern: /\b(?:c[\s\-_]*p[\s\-_]*u|cpu)\b/gi, replacement: "CPU" },
  // GPU
  { pattern: /\b(?:g[\s\-_]*p[\s\-_]*u|gpu)\b/gi, replacement: "GPU" },
  // TPU
  { pattern: /\b(?:t[\s\-_]*p[\s\-_]*u|tpu)\b/gi, replacement: "TPU" },
  // CDN
  { pattern: /\b(?:c[\s\-_]*d[\s\-_]*n|cdn)\b/gi, replacement: "CDN" },
  // CRUD
  { pattern: /\b(?:c[\s\-_]*r[\s\-_]*u[\s\-_]*d|crud)\b/gi, replacement: "CRUD" },
  // DFS
  { pattern: /\b(?:d[\s\-_]*f[\s\-_]*s|dfs)\b/gi, replacement: "DFS" },
  // BFS
  { pattern: /\b(?:b[\s\-_]*f[\s\-_]*s|bfs)\b/gi, replacement: "BFS" },
  // HNSW
  { pattern: /\b(?:h[\s\-_]*n[\s\-_]*s[\s\-_]*w|hnsw)\b/gi, replacement: "HNSW" },
  // GIN
  { pattern: /\b(?:g[\s\-_]*i[\s\-_]*n|gin)\b/gi, replacement: "GIN" },
];

/**
 * Normalizes common phonetic mis-recognitions from accented speech to standard developer technical terms.
 */
export function normalizeTechnicalTerms(text: string): string {
  if (!text) {
    return "";
  }

  let result = text;

  // 1. Apply compound policies first
  for (const { pattern, replacement } of COMPOUND_RULES) {
    result = result.replace(pattern, replacement);
  }

  // 2. Apply system and tool replacements
  for (const { pattern, replacement } of SYSTEM_TOOL_RULES) {
    result = result.replace(pattern, replacement);
  }

  // 3. Apply technical acronym replacements
  for (const { pattern, replacement } of ACRONYM_RULES) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

// ============================================================================
// Acoustic Junk & Hallucination Filtering
// ============================================================================

/**
 * Returns true if text is empty, only bracketed annotations
 * ([BLANK_AUDIO], (coughs), *music*, ♪), or contains no alphanumeric characters.
 */
export function isJunk(text: string): boolean {
  if (!text || typeof text !== "string") {
    return true;
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return true;
  }

  // Strip bracketed annotations: [...], (...), *...*, and musical symbols
  const stripped = trimmed
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^\)]*\)/g, "")
    .replace(/\*[^\*]*\*/g, "")
    .replace(/[♪♫♩♬]/g, "")
    .trim();

  // If no alphanumeric or Unicode letter/digit characters remain (supports Hindi Devanagari and international scripts), it is considered junk/silence
  return !/[\p{L}\p{N}]/u.test(stripped);
}

// Stop words to exclude when extracting meaningful items from hint text
const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or", "is",
  "are", "be", "with", "this", "that", "it", "as", "by", "from", "terms",
  "technical", "keywords", "context", "vocabulary", "assistant", "system", "prompt"
]);

// Section header regex patterns commonly found in prompts
const SECTION_LABEL_PATTERN = /^(?:(?:technical\s+)?terms|keywords|context|vocabulary|system|prompt|agav(?:\s+assistant)?)[:\s.-]*$/i;

/**
 * Detects when Whisper regurgitated the prompt tokens instead of real speech on silence:
 * Checks if the text contains only hint section labels or if >= 3 hint items are echoed back
 * comprising >= 50% of word count.
 */
export function isHintEcho(text: string, hint?: string): boolean {
  if (!text || !text.trim() || !hint || !hint.trim()) {
    return false;
  }

  const cleanText = text.trim();

  // 1. Check if text contains only hint section labels
  if (SECTION_LABEL_PATTERN.test(cleanText)) {
    return true;
  }

  // Also check if removing all known section labels leaves no letters or digits
  const strippedLabels = cleanText
    .replace(/(?:technical\s+terms?|terms?|keywords?|context|vocabulary|agav(?:\s+assistant)?|prompt|system)[:\s.-]*/gi, "")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(strippedLabels)) {
    return true;
  }

  // 2. Extract hint items from hint
  // Split hint by punctuation separators like commas, colons, semicolons, newlines, pipes
  const rawSegments = hint.split(/[,:;\n|\t]+/);
  const hintItems = new Set<string>();

  for (const segment of rawSegments) {
    const cleanSegment = segment
      .replace(/(?:technical\s+terms?|terms?|keywords?|context|vocabulary|agav(?:\s+assistant)?|prompt|system)/gi, "")
      .trim()
      .toLowerCase();

    // Extract individual words or sub-phrases
    const segmentWords = cleanSegment.split(/\s+/).map(w => w.replace(/^[^\w]+|[^\w]+$/g, "")).filter(w => w.length > 0);
    for (const word of segmentWords) {
      if (word.length >= 2 && !STOP_WORDS.has(word)) {
        hintItems.add(word);
      }
    }
  }

  if (hintItems.size === 0) {
    return false;
  }

  // Extract words from transcribed text
  const textWords = cleanText
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter(w => w.length > 0);

  if (textWords.length === 0) {
    return false;
  }

  let matchingWordsCount = 0;
  const matchedHintItems = new Set<string>();

  for (const word of textWords) {
    if (hintItems.has(word)) {
      matchingWordsCount++;
      matchedHintItems.add(word);
    }
  }

  const echoedItemCount = matchedHintItems.size;
  const ratio = matchingWordsCount / textWords.length;

  // >= 3 hint items echoed back comprising >= 50% of word count
  return echoedItemCount >= 3 && ratio >= 0.5;
}

/**
 * Detects and collapses pathological Whisper repetition loops and hallucinations
 * (e.g. "of the website of the website of the website...") down to a single instance,
 * including trimming incomplete trailing fragments of the repeated pattern.
 */
export function deduplicateRepeatedPhrases(text: string): string {
  if (!text || typeof text !== "string") {
    return "";
  }

  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= 2) {
    return trimmed;
  }

  let modified = true;
  while (modified) {
    modified = false;
    const maxWindow = Math.min(12, Math.floor(words.length / 2));
    for (let w = maxWindow; w >= 1; w--) {
      for (let i = 0; i <= words.length - 2 * w; i++) {
        const sampleWords = words
          .slice(i, i + w)
          .map((x) => x.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, ""));

        // If window consists entirely of the same word repeated, let the 1-word window handle it
        if (w > 1 && sampleWords.every((x) => x === sampleWords[0])) {
          continue;
        }

        const pattern = sampleWords.join(" ");
        if (!pattern.trim()) {
          continue;
        }

        let repeatCount = 1;
        let nextPos = i + w;
        while (nextPos + w <= words.length) {
          const nextPattern = words
            .slice(nextPos, nextPos + w)
            .map((x) => x.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, ""))
            .join(" ");

          if (pattern === nextPattern) {
            repeatCount++;
            nextPos += w;
          } else {
            break;
          }
        }

        // Single word repeats must occur >= 3 times (allowing legitimate speech like "very very")
        // Multi-word phrases (w >= 2) must occur >= 2 times
        const threshold = w === 1 ? 3 : 2;
        if (repeatCount >= threshold) {
          // Check if there is a partial prefix of the pattern immediately following
          let partialLen = 0;
          for (let p = 1; p < w && nextPos + p <= words.length; p++) {
            const partialPattern = words
              .slice(nextPos, nextPos + p)
              .map((x) => x.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, ""))
              .join(" ");
            const prefixPattern = words
              .slice(i, i + p)
              .map((x) => x.toLowerCase().replace(/^[^\w]+|[^\w]+$/g, ""))
              .join(" ");
            if (partialPattern === prefixPattern) {
              partialLen = p;
            }
          }

          words.splice(i + w, (repeatCount - 1) * w + partialLen);
          modified = true;
          break;
        }
      }
      if (modified) {
        break;
      }
    }
  }

  return words.join(" ").trim();
}

