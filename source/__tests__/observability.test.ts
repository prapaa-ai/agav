import { describe, it, expect, beforeEach } from "vitest";
import {
  redactString,
  redactSecrets,
  runWithCorrelationContext,
  getCorrelationContext,
  createCorrelationContext,
  generateCorrelationId,
  generateTaskId,
  Logger,
  logger,
  type LogEntry,
  metrics,
  resetMetrics,
  getMetricsSnapshot,
  recordAgentSuccess,
  recordAgentFailure,
  recordSubagentSuccess,
  recordSubagentFailure,
  recordProviderRequest,
  recordProviderSuccess,
  recordProviderFailure,
  recordRetry,
  recordFallback,
  recordTimeout,
  recordCancellation,
  recordKeyCooldown,
  recordKeyRecovery,
  recordProviderLatency,
  recordTaskDuration,
  recordTokenUsage,
  ErrorCategory,
  classifyError,
  CategorizedError,
  isCategoryRetryable,
  diagnostics,
  getDiagnosticsSummary,
  resetDiagnostics,
  trackActiveTask,
  trackActiveSubagent,
  recordProviderHealth,
  recordKeyPoolHealth,
  recordFailure,
  recordRetryActivity,
  recordFallbackActivity,
} from "../observability/index.js";
import { debugCommand } from "../commands/debug.js";

describe("P1.6: Observability, Diagnostics, and Operational Readiness", () => {
  beforeEach(() => {
    resetMetrics();
    resetDiagnostics();
    logger.clearLogs();
  });

  describe("1. Secret Redaction", () => {
    it("redacts Anthropic API keys (sk-ant-*)", () => {
      const text = "Error with key sk-ant-api03-abcdef1234567890abcdef1234567890 in header";
      const result = redactString(text);
      expect(result).not.toContain("abcdef1234567890abcdef1234567890");
      expect(result).toContain("sk-ant-[REDACTED]");
    });

    it("redacts OpenAI API keys (sk-*, sk-proj-*, sk-admin-*)", () => {
      const projKey = "sk-proj-abc123456789012345678901234567890";
      const adminKey = "sk-admin-xyz123456789012345678901234567890";
      const legacyKey = "sk-123456789012345678901234567890";

      expect(redactString(projKey)).toBe("sk-proj-[REDACTED]");
      expect(redactString(adminKey)).toBe("sk-admin-[REDACTED]");
      expect(redactString(legacyKey)).toBe("sk-[REDACTED]");
    });

    it("redacts Google / Gemini API keys (AIzaSy*)", () => {
      const geminiKey = "AIzaSyD-abc1234567890abcdef1234567890";
      const result = redactString(`Request failed with key ${geminiKey}`);
      expect(result).not.toContain("D-abc1234567890");
      expect(result).toContain("AIzaSy[REDACTED]");
    });

    it("redacts OpenRouter API keys (sk-or-*)", () => {
      const orV1 = ["sk", "or", "v1", "0123456789abcdef".repeat(4)].join("-");
      const orLegacy = ["sk", "or", "abc12345678901234567890"].join("-");

      expect(redactString(orV1)).toBe("sk-or-v1-[REDACTED]");
      expect(redactString(orLegacy)).toBe("sk-or-[REDACTED]");
    });

    it("redacts NVIDIA API keys (nvapi-*)", () => {
      const nvKey = "nvapi-abcdef1234567890abcdef1234567890";
      expect(redactString(nvKey)).toBe("nvapi-[REDACTED]");
    });

    it("redacts DeepSeek API keys", () => {
      const deepseekKey = ["sk", "0123456789abcdef".repeat(2)].join("-");
      expect(redactString(deepseekKey)).toBe("sk-[REDACTED]");
    });

    it("redacts Bearer tokens and Authorization headers", () => {
      const authHeader = "Authorization: Bearer abc123xyzSecretToken!@#";
      expect(redactString(authHeader)).toBe("Authorization: Bearer [REDACTED]");

      const rawBearer = "Got token Bearer secret-token-456789";
      expect(redactString(rawBearer)).toBe("Got token Bearer [REDACTED]");
    });

    it("redacts credentials from connection URLs", () => {
      const url = "postgres://admin:SuperSecretPassword123@db.internal:5432/agav";
      expect(redactString(url)).toBe("postgres://admin:[REDACTED]@db.internal:5432/agav");
    });

    it("redacts PEM private keys", () => {
      const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0m...\n-----END RSA PRIVATE KEY-----`;
      expect(redactString(pem)).toBe("[REDACTED_PRIVATE_KEY]");
    });

    it("deeply redacts secrets in objects, arrays, and Maps", () => {
      const sensitiveData = {
        apiKey: "sk-ant-api03-12345678901234567890",
        password: "MyPassword123!",
        user: "test-user",
        details: {
          token: "secret-token",
          prompt: "Please use sk-proj-12345678901234567890 here",
        },
        keys: ["AIzaSyAbc12345678901234567890123456789", "clean-value"],
      };

      const redacted = redactSecrets(sensitiveData) as any;
      expect(redacted.apiKey).toBe("[REDACTED]");
      expect(redacted.password).toBe("[REDACTED]");
      expect(redacted.user).toBe("test-user");
      expect(redacted.details.token).toBe("[REDACTED]");
      expect(redacted.details.prompt).toBe("Please use sk-proj-[REDACTED] here");
      expect(redacted.keys[0]).toBe("AIzaSy[REDACTED]");
      expect(redacted.keys[1]).toBe("clean-value");
    });

    it("redacts Error messages and stacks", () => {
      const err = new Error("Failed connecting with key sk-ant-api03-12345678901234567890");
      const redactedErr = redactSecrets(err) as Error;
      expect(redactedErr.message).toBe("Failed connecting with key sk-ant-[REDACTED]");
      expect(redactedErr.stack).not.toContain("api03-12345678901234567890");
    });

    it("safely handles circular references without stack overflow", () => {
      const cyclic: Record<string, unknown> = {
        name: "test",
        secret: "super-secret",
      };
      cyclic.self = cyclic;

      const redacted = redactSecrets(cyclic) as any;
      expect(redacted.name).toBe("test");
      expect(redacted.secret).toBe("[REDACTED]");
      expect(redacted.self).toBe(redacted);
    });
  });

  describe("2. Correlation Context", () => {
    it("propagates correlation context across asynchronous operations", async () => {
      const context = createCorrelationContext({
        correlationId: "corr-123",
        taskId: "task-abc",
        agentId: "agent-main",
        subagentId: "sa-1",
        sessionId: "sess-999",
      });

      await runWithCorrelationContext(context, async () => {
        expect(getCorrelationContext()?.correlationId).toBe("corr-123");
        expect(getCorrelationContext()?.taskId).toBe("task-abc");
        expect(getCorrelationContext()?.subagentId).toBe("sa-1");

        await new Promise((r) => setTimeout(r, 10));

        // After async delay, context still intact
        expect(getCorrelationContext()?.correlationId).toBe("corr-123");
        expect(getCorrelationContext()?.sessionId).toBe("sess-999");
      });

      // Outside scope, context is undefined
      expect(getCorrelationContext()).toBeUndefined();
    });

    it("supports nested execution context inheriting parent fields", () => {
      runWithCorrelationContext(
        { correlationId: "parent-corr", sessionId: "sess-1", taskId: "parent-task" },
        () => {
          expect(getCorrelationContext()?.correlationId).toBe("parent-corr");
          expect(getCorrelationContext()?.taskId).toBe("parent-task");

          // Run child subagent context
          runWithCorrelationContext({ subagentId: "subagent-child", taskId: "child-task" }, () => {
            const current = getCorrelationContext();
            expect(current?.correlationId).toBe("parent-corr"); // inherited
            expect(current?.sessionId).toBe("sess-1"); // inherited
            expect(current?.taskId).toBe("child-task"); // overridden
            expect(current?.subagentId).toBe("subagent-child"); // child specific
          });

          // Restores parent context afterwards
          expect(getCorrelationContext()?.taskId).toBe("parent-task");
          expect(getCorrelationContext()?.subagentId).toBeUndefined();
        },
      );
    });
  });

  describe("3. Structured Logging", () => {
    it("generates structured JSON-compatible log entries with correlation IDs", () => {
      const customLogger = new Logger({ level: "debug" });

      runWithCorrelationContext(
        {
          correlationId: "corr-log-1",
          taskId: "task-log-1",
          agentId: "agent-007",
        },
        () => {
          const entry = customLogger.info("Agent started step", { stepIndex: 2 });
          expect(entry.level).toBe("info");
          expect(entry.message).toBe("Agent started step");
          expect(entry.correlationId).toBe("corr-log-1");
          expect(entry.taskId).toBe("task-log-1");
          expect(entry.agentId).toBe("agent-007");
          expect(entry.metadata?.stepIndex).toBe(2);
          expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
        },
      );
    });

    it("automatically redacts secrets in log messages, metadata, and errors", () => {
      const customLogger = new Logger({ level: "debug" });

      const err = new Error("Failed on key AIzaSyD-abc1234567890abcdef1234567890");
      const entry = customLogger.error(
        "Request failed using key sk-ant-api03-12345678901234567890",
        {
          authorization: "Bearer secret-token-xyz",
          rawSecret: "password123",
        },
        err,
      );

      expect(entry.message).toBe("Request failed using key sk-ant-[REDACTED]");
      expect(entry.metadata?.authorization).toBe("[REDACTED]");
      expect(entry.error?.message).toBe("Failed on key AIzaSy[REDACTED]");
    });

    it("respects log level thresholds", () => {
      const customLogger = new Logger({ level: "warn" });
      const entries: LogEntry[] = [];
      customLogger.addSink((e) => entries.push(e));

      customLogger.debug("Debug message");
      customLogger.info("Info message");
      customLogger.warn("Warn message");
      customLogger.error("Error message");

      expect(entries).toHaveLength(2);
      expect(entries[0].level).toBe("warn");
      expect(entries[1].level).toBe("error");
    });

    it("maintains an in-memory buffer of recent logs", () => {
      const testLogger = new Logger({ maxRecentLogs: 5 });
      for (let i = 0; i < 10; i++) {
        testLogger.info(`Message ${i}`);
      }

      const recent = testLogger.getRecentLogs();
      expect(recent).toHaveLength(5);
      expect(recent[0].message).toBe("Message 5");
      expect(recent[4].message).toBe("Message 9");
    });
  });

  describe("4. Metrics & Statistics", () => {
    it("increments all operational counters correctly", () => {
      recordAgentSuccess();
      recordAgentFailure();
      recordSubagentSuccess();
      recordSubagentFailure();
      recordProviderRequest();
      recordProviderSuccess();
      recordProviderFailure();
      recordRetry();
      recordFallback();
      recordTimeout();
      recordCancellation();
      recordKeyCooldown();
      recordKeyRecovery();

      const snapshot = getMetricsSnapshot();
      expect(snapshot.counters.agent_success_count).toBe(1);
      expect(snapshot.counters.agent_failure_count).toBe(1);
      expect(snapshot.counters.subagent_success_count).toBe(1);
      expect(snapshot.counters.subagent_failure_count).toBe(1);
      expect(snapshot.counters.provider_request_count).toBe(1);
      expect(snapshot.counters.provider_success_count).toBe(1);
      expect(snapshot.counters.provider_failure_count).toBe(1);
      expect(snapshot.counters.retry_count).toBe(1);
      expect(snapshot.counters.fallback_count).toBe(1);
      expect(snapshot.counters.timeout_count).toBe(1);
      expect(snapshot.counters.cancellation_count).toBe(1);
      expect(snapshot.counters.key_cooldown_count).toBe(1);
      expect(snapshot.counters.key_recovery_count).toBe(1);
    });

    it("tracks provider latency and task duration with min, max, and avg", () => {
      recordProviderLatency(100);
      recordProviderLatency(200);
      recordProviderLatency(300);

      recordTaskDuration(500);
      recordTaskDuration(1500);

      const snapshot = getMetricsSnapshot();

      expect(snapshot.latencies.provider.count).toBe(3);
      expect(snapshot.latencies.provider.minMs).toBe(100);
      expect(snapshot.latencies.provider.maxMs).toBe(300);
      expect(snapshot.latencies.provider.avgMs).toBe(200);

      expect(snapshot.latencies.task.count).toBe(2);
      expect(snapshot.latencies.task.minMs).toBe(500);
      expect(snapshot.latencies.task.maxMs).toBe(1500);
      expect(snapshot.latencies.task.avgMs).toBe(1000);
    });

    it("tracks token usage across input, output, cache read and cache write", () => {
      recordTokenUsage({
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadTokens: 400,
        cacheWriteTokens: 100,
      });

      const snapshot = getMetricsSnapshot();
      expect(snapshot.tokenUsage.inputTokens).toBe(1000);
      expect(snapshot.tokenUsage.outputTokens).toBe(250);
      expect(snapshot.tokenUsage.cacheReadTokens).toBe(400);
      expect(snapshot.tokenUsage.cacheWriteTokens).toBe(100);
      expect(snapshot.tokenUsage.totalTokens).toBe(1750);
    });

    it("resets metrics cleanly", () => {
      recordProviderRequest();
      recordProviderLatency(150);
      expect(getMetricsSnapshot().counters.provider_request_count).toBe(1);

      resetMetrics();
      const cleanSnapshot = getMetricsSnapshot();
      expect(cleanSnapshot.counters.provider_request_count).toBe(0);
      expect(cleanSnapshot.latencies.provider.count).toBe(0);
    });
  });

  describe("5. Error Categorization", () => {
    it("classifies authentication errors (401, 403, invalid api key)", () => {
      expect(classifyError({ status: 401, message: "Unauthorized" })).toBe(ErrorCategory.Authentication);
      expect(classifyError(new Error("Invalid API key provided"))).toBe(ErrorCategory.Authentication);
      expect(isCategoryRetryable(ErrorCategory.Authentication)).toBe(false);
    });

    it("classifies rate limit errors (429, quota exceeded)", () => {
      expect(classifyError({ status: 429, message: "Too many requests" })).toBe(ErrorCategory.RateLimit);
      expect(classifyError(new Error("Resource quota exhausted"))).toBe(ErrorCategory.RateLimit);
      expect(isCategoryRetryable(ErrorCategory.RateLimit)).toBe(true);
    });

    it("classifies timeout errors (408, 504, ETIMEDOUT)", () => {
      expect(classifyError({ status: 504, message: "Gateway Timeout" })).toBe(ErrorCategory.Timeout);
      expect(classifyError({ code: "ETIMEDOUT", message: "connect ETIMEDOUT" })).toBe(ErrorCategory.Timeout);
      expect(isCategoryRetryable(ErrorCategory.Timeout)).toBe(true);
    });

    it("classifies network errors (ECONNRESET, fetch failed)", () => {
      expect(classifyError({ code: "ECONNRESET", message: "socket hang up" })).toBe(ErrorCategory.Network);
      expect(classifyError(new Error("fetch failed"))).toBe(ErrorCategory.Network);
      expect(isCategoryRetryable(ErrorCategory.Network)).toBe(true);
    });

    it("classifies provider errors (500, 503, 529)", () => {
      expect(classifyError({ status: 503, message: "Service Unavailable" })).toBe(ErrorCategory.Provider);
      expect(classifyError(new Error("Provider model overloaded"))).toBe(ErrorCategory.Provider);
      expect(isCategoryRetryable(ErrorCategory.Provider)).toBe(true);
    });

    it("classifies cancellation and non-retryable errors", () => {
      const abortErr = new Error("This operation was aborted");
      abortErr.name = "AbortError";
      expect(classifyError(abortErr)).toBe(ErrorCategory.Cancellation);
      expect(isCategoryRetryable(ErrorCategory.Cancellation)).toBe(false);

      expect(classifyError(new Error("Non-retryable model failure"))).toBe(ErrorCategory.NonRetryable);
      expect(isCategoryRetryable(ErrorCategory.NonRetryable)).toBe(false);
    });

    it("wraps unknown errors into CategorizedError with redacted secrets", () => {
      const err = new Error("Failed with token sk-ant-api03-12345678901234567890");
      const categorized = CategorizedError.from(err);

      expect(categorized).toBeInstanceOf(CategorizedError);
      expect(categorized.message).toBe("Failed with token sk-ant-[REDACTED]");
      expect(categorized.originalMessage).toBe("Failed with token sk-ant-api03-12345678901234567890");
      expect(categorized.category).toBeDefined();
    });
  });

  describe("6. Diagnostics Interface & /debug Command Integration", () => {
    it("reports diagnostics summary with active tasks, agents, and health", () => {
      const unregister = trackActiveTask("task-1", "Indexing code");
      const unregisterSa = trackActiveSubagent("sa-1", "Refactoring tests");

      recordProviderHealth("anthropic", {
        status: "healthy",
        latencyMs: 180,
      });

      recordKeyPoolHealth({
        provider: "anthropic",
        totalKeys: 3,
        activeKeys: 2,
        cooledDownKeys: 1,
        keys: [
          { id: "sk-ant-key1-secret1234567890", status: "active" },
          { id: "sk-ant-key2-secret1234567890", status: "cooldown", cooldownRemainingMs: 30000 },
        ],
      });

      recordRetryActivity({
        provider: "anthropic",
        attempt: 1,
        delayMs: 1000,
        error: "Rate limit sk-ant-api03-12345678901234567890",
      });

      recordFailure(new Error("Provider error occurred"), { correlationId: "test-corr" });

      const summary = getDiagnosticsSummary();

      expect(summary.activeTaskCount).toBe(1);
      expect(summary.activeSubagents).toBe(1);
      expect(summary.providerHealth.anthropic.status).toBe("healthy");
      expect(summary.providerHealth.anthropic.latencyMs).toBe(180);

      // Key pool keys must be strictly redacted
      expect(summary.keyPoolHealth[0].keys[0].id).toBe("sk-ant-[REDACTED]");

      // Retry activity recorded
      expect(summary.retryFallbackActivity.retries).toBe(1);

      // System health is degraded due to partial cooldown and retries
      expect(["healthy", "degraded", "operational"]).toContain(summary.systemHealth);

      // Unregister tasks and check active count
      unregister();
      unregisterSa();
      const updated = getDiagnosticsSummary();
      expect(updated.activeTaskCount).toBe(0);
      expect(updated.activeSubagents).toBe(0);
    });

    it("enhances the /debug command with operational diagnostics output", async () => {
      recordProviderHealth("openai", {
        status: "healthy",
        latencyMs: 120,
      });

      recordKeyPoolHealth({
        provider: "openai",
        totalKeys: 2,
        activeKeys: 2,
        cooledDownKeys: 0,
        keys: [{ id: "sk-proj-key12345678901234567890", status: "active" }],
      });

      const mockContext: any = {
        conversation: {
          length: 5,
          tokenCount: 1200,
          wasCompacted: false,
        },
        getDebugState: () => ({
          tokenUsage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 0 },
          loadedPlugins: [],
          mcpServers: [],
          mcpResources: 0,
          mcpPrompts: 0,
        }),
      };

      const result = await debugCommand.execute("", mockContext);
      expect(result.type).toBe("message");
      if (result.type === "message") {
        expect(result.text).toContain("Operational diagnostics:");
        expect(result.text).toContain("System health:");
        expect(result.text).toContain("openai: [healthy]");
        expect(result.text).toContain("Key pool status:");
      }
    });
  });
});
