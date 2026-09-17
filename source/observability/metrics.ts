/**
 * Production-grade in-memory metrics registry for Agav.
 * Tracks agent execution, subagent orchestration, provider latency,
 * retries, fallbacks, token usage, and key cooldowns.
 */

export type MetricCounter =
  | "agent_success_count"
  | "agent_failure_count"
  | "subagent_success_count"
  | "subagent_failure_count"
  | "provider_request_count"
  | "provider_success_count"
  | "provider_failure_count"
  | "retry_count"
  | "fallback_count"
  | "timeout_count"
  | "cancellation_count"
  | "key_cooldown_count"
  | "key_recovery_count";

export interface LatencyMetric {
  count: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

export interface TokenUsageMetric {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  counters: Record<MetricCounter, number>;
  latencies: {
    provider: LatencyMetric;
    task: LatencyMetric;
  };
  tokenUsage: TokenUsageMetric;
}

const INITIAL_LATENCY = (): LatencyMetric => ({
  count: 0,
  totalMs: 0,
  avgMs: 0,
  minMs: 0,
  maxMs: 0,
});

const INITIAL_COUNTERS = (): Record<MetricCounter, number> => ({
  agent_success_count: 0,
  agent_failure_count: 0,
  subagent_success_count: 0,
  subagent_failure_count: 0,
  provider_request_count: 0,
  provider_success_count: 0,
  provider_failure_count: 0,
  retry_count: 0,
  fallback_count: 0,
  timeout_count: 0,
  cancellation_count: 0,
  key_cooldown_count: 0,
  key_recovery_count: 0,
});

const INITIAL_TOKEN_USAGE = (): TokenUsageMetric => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
});

export class MetricsRegistry {
  private counters: Record<MetricCounter, number>;
  private providerLatency: LatencyMetric;
  private taskDuration: LatencyMetric;
  private tokenUsage: TokenUsageMetric;

  constructor() {
    this.counters = INITIAL_COUNTERS();
    this.providerLatency = INITIAL_LATENCY();
    this.taskDuration = INITIAL_LATENCY();
    this.tokenUsage = INITIAL_TOKEN_USAGE();
  }

  increment(counter: MetricCounter, by = 1): void {
    if (counter in this.counters) {
      this.counters[counter] += by;
    }
  }

  recordProviderLatency(durationMs: number): void {
    if (durationMs < 0) return;
    this.updateLatency(this.providerLatency, durationMs);
  }

  recordTaskDuration(durationMs: number): void {
    if (durationMs < 0) return;
    this.updateLatency(this.taskDuration, durationMs);
  }

  recordTokenUsage(usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void {
    const input = Math.max(0, usage.inputTokens || 0);
    const output = Math.max(0, usage.outputTokens || 0);
    const cacheRead = Math.max(0, usage.cacheReadTokens || 0);
    const cacheWrite = Math.max(0, usage.cacheWriteTokens || 0);

    this.tokenUsage.inputTokens += input;
    this.tokenUsage.outputTokens += output;
    this.tokenUsage.cacheReadTokens += cacheRead;
    this.tokenUsage.cacheWriteTokens += cacheWrite;
    this.tokenUsage.totalTokens += input + output + cacheRead + cacheWrite;
  }

  getMetricsSnapshot(): MetricsSnapshot {
    return {
      timestamp: new Date().toISOString(),
      counters: { ...this.counters },
      latencies: {
        provider: { ...this.providerLatency },
        task: { ...this.taskDuration },
      },
      tokenUsage: { ...this.tokenUsage },
    };
  }

  resetMetrics(): void {
    this.counters = INITIAL_COUNTERS();
    this.providerLatency = INITIAL_LATENCY();
    this.taskDuration = INITIAL_LATENCY();
    this.tokenUsage = INITIAL_TOKEN_USAGE();
  }

  private updateLatency(metric: LatencyMetric, durationMs: number): void {
    metric.count++;
    metric.totalMs += durationMs;
    metric.minMs = metric.count === 1 ? durationMs : Math.min(metric.minMs, durationMs);
    metric.maxMs = metric.count === 1 ? durationMs : Math.max(metric.maxMs, durationMs);
    metric.avgMs = metric.totalMs / metric.count;
  }
}

/** Global default metrics instance. */
export const metrics = new MetricsRegistry();

// Convenience top-level functions
export function incrementCounter(counter: MetricCounter, by = 1): void {
  metrics.increment(counter, by);
}

export function recordProviderLatency(durationMs: number): void {
  metrics.recordProviderLatency(durationMs);
}

export function recordTaskDuration(durationMs: number): void {
  metrics.recordTaskDuration(durationMs);
}

export function recordTokenUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): void {
  metrics.recordTokenUsage(usage);
}

export function getMetricsSnapshot(): MetricsSnapshot {
  return metrics.getMetricsSnapshot();
}

export function resetMetrics(): void {
  metrics.resetMetrics();
}

// Dedicated counter helpers
export const recordAgentSuccess = () => metrics.increment("agent_success_count");
export const recordAgentFailure = () => metrics.increment("agent_failure_count");
export const recordSubagentSuccess = () => metrics.increment("subagent_success_count");
export const recordSubagentFailure = () => metrics.increment("subagent_failure_count");
export const recordProviderRequest = () => metrics.increment("provider_request_count");
export const recordProviderSuccess = () => metrics.increment("provider_success_count");
export const recordProviderFailure = () => metrics.increment("provider_failure_count");
export const recordRetry = () => metrics.increment("retry_count");
export const recordFallback = () => metrics.increment("fallback_count");
export const recordTimeout = () => metrics.increment("timeout_count");
export const recordCancellation = () => metrics.increment("cancellation_count");
export const recordKeyCooldown = () => metrics.increment("key_cooldown_count");
export const recordKeyRecovery = () => metrics.increment("key_recovery_count");
