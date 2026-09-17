import { getMetricsSnapshot, type MetricsSnapshot, recordRetry, recordFallback } from "./metrics.js";
import { classifyError, type ErrorCategory } from "./errors.js";
import { redactString, redactSecrets } from "./redaction.js";

export type HealthStatus = "healthy" | "degraded" | "critical" | "operational";

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  lastChecked?: string;
  latencyMs?: number;
  error?: string;
}

export interface KeyPoolItem {
  id: string; // Redacted key identifier
  status: "active" | "cooldown";
  cooldownRemainingMs?: number;
}

export interface KeyPoolHealth {
  provider: string;
  totalKeys: number;
  activeKeys: number;
  cooledDownKeys: number;
  keys: KeyPoolItem[];
}

export interface FailureRecord {
  timestamp: string;
  category: ErrorCategory;
  message: string;
  code?: string;
  status?: number;
  context?: Record<string, unknown>;
}

export interface ActivityEvent {
  timestamp: string;
  type: "retry" | "fallback";
  details: Record<string, unknown>;
}

export interface DiagnosticsSummary {
  systemHealth: HealthStatus;
  uptimeSeconds: number;
  activeTaskCount: number;
  activeAgents: number;
  activeSubagents: number;
  providerHealth: Record<string, ProviderHealth>;
  keyPoolHealth: KeyPoolHealth[];
  recentFailures: FailureRecord[];
  retryFallbackActivity: {
    retries: number;
    fallbacks: number;
    recentEvents: ActivityEvent[];
  };
  metrics: MetricsSnapshot;
}

class DiagnosticsRegistry {
  private startTime = Date.now();
  private activeTasks = new Map<string, string>();
  private activeAgents = new Map<string, string>();
  private activeSubagents = new Map<string, string>();
  private providerHealthMap = new Map<string, ProviderHealth>();
  private keyPoolHealthMap = new Map<string, KeyPoolHealth>();
  private recentFailuresList: FailureRecord[] = [];
  private recentEventsList: ActivityEvent[] = [];
  private readonly maxFailures = 50;
  private readonly maxEvents = 50;

  trackActiveTask(taskId: string, description = "task"): () => void {
    this.activeTasks.set(taskId, description);
    return () => {
      this.activeTasks.delete(taskId);
    };
  }

  trackActiveAgent(agentId: string, name = "agent"): () => void {
    this.activeAgents.set(agentId, name);
    return () => {
      this.activeAgents.delete(agentId);
    };
  }

  trackActiveSubagent(subagentId: string, title = "subagent"): () => void {
    this.activeSubagents.set(subagentId, title);
    return () => {
      this.activeSubagents.delete(subagentId);
    };
  }

  recordProviderHealth(provider: string, health: ProviderHealth): void {
    this.providerHealthMap.set(provider, {
      ...health,
      error: health.error ? redactString(health.error) : undefined,
      lastChecked: health.lastChecked ?? new Date().toISOString(),
    });
  }

  recordKeyPoolHealth(pool: KeyPoolHealth): void {
    const redactedKeys: KeyPoolItem[] = (pool.keys || []).map((k) => ({
      id: redactString(k.id),
      status: k.status,
      cooldownRemainingMs: k.cooldownRemainingMs,
    }));

    this.keyPoolHealthMap.set(pool.provider, {
      provider: pool.provider,
      totalKeys: pool.totalKeys,
      activeKeys: pool.activeKeys,
      cooledDownKeys: pool.cooledDownKeys,
      keys: redactedKeys,
    });
  }

  recordFailure(error: unknown, context?: Record<string, unknown>): void {
    const category = classifyError(error);
    const rawMsg = error instanceof Error ? error.message : String(error ?? "Unknown error");
    const code = (error as any)?.code;
    const status = (error as any)?.status ?? (error as any)?.statusCode;

    const record: FailureRecord = {
      timestamp: new Date().toISOString(),
      category,
      message: redactString(rawMsg),
      code,
      status,
      context: context ? (redactSecrets(context) as Record<string, unknown>) : undefined,
    };

    this.recentFailuresList.push(record);
    if (this.recentFailuresList.length > this.maxFailures) {
      this.recentFailuresList.shift();
    }
  }

  recordRetryActivity(details: { provider?: string; attempt: number; delayMs?: number; error?: string }): void {
    recordRetry();
    const redactedDetails = redactSecrets(details) as Record<string, unknown>;
    this.recentEventsList.push({
      timestamp: new Date().toISOString(),
      type: "retry",
      details: redactedDetails,
    });
    if (this.recentEventsList.length > this.maxEvents) {
      this.recentEventsList.shift();
    }
  }

  recordFallbackActivity(details: { fromProvider: string; toProvider: string; reason: string }): void {
    recordFallback();
    const redactedDetails = redactSecrets(details) as Record<string, unknown>;
    this.recentEventsList.push({
      timestamp: new Date().toISOString(),
      type: "fallback",
      details: redactedDetails,
    });
    if (this.recentEventsList.length > this.maxEvents) {
      this.recentEventsList.shift();
    }
  }

  getDiagnosticsSummary(): DiagnosticsSummary {
    const metricsSnapshot = getMetricsSnapshot();

    // Determine overall system health
    let systemHealth: HealthStatus = "healthy";

    // Check provider health
    const providers = Array.from(this.providerHealthMap.values());
    const hasUnhealthyProvider = providers.some((p) => p.status === "unhealthy");
    const hasDegradedProvider = providers.some((p) => p.status === "degraded");

    // Check key pools
    const keyPools = Array.from(this.keyPoolHealthMap.values());
    const hasExhaustedPool = keyPools.some((kp) => kp.totalKeys > 0 && kp.activeKeys === 0);
    const hasPartialCooldown = keyPools.some((kp) => kp.cooledDownKeys > 0);

    if (hasUnhealthyProvider || hasExhaustedPool) {
      systemHealth = "critical";
    } else if (hasDegradedProvider || hasPartialCooldown || metricsSnapshot.counters.fallback_count > 0) {
      systemHealth = "degraded";
    } else {
      systemHealth = "operational";
    }

    const providerObj: Record<string, ProviderHealth> = {};
    for (const [name, health] of this.providerHealthMap.entries()) {
      providerObj[name] = { ...health };
    }

    const uptimeSeconds = (Date.now() - this.startTime) / 1000;

    return {
      systemHealth,
      uptimeSeconds,
      activeTaskCount: this.activeTasks.size,
      activeAgents: this.activeAgents.size,
      activeSubagents: this.activeSubagents.size,
      providerHealth: providerObj,
      keyPoolHealth: Array.from(this.keyPoolHealthMap.values()),
      recentFailures: [...this.recentFailuresList],
      retryFallbackActivity: {
        retries: metricsSnapshot.counters.retry_count,
        fallbacks: metricsSnapshot.counters.fallback_count,
        recentEvents: [...this.recentEventsList],
      },
      metrics: metricsSnapshot,
    };
  }

  resetDiagnostics(): void {
    this.startTime = Date.now();
    this.activeTasks.clear();
    this.activeAgents.clear();
    this.activeSubagents.clear();
    this.providerHealthMap.clear();
    this.keyPoolHealthMap.clear();
    this.recentFailuresList = [];
    this.recentEventsList = [];
  }
}

/** Global default diagnostics registry instance. */
export const diagnostics = new DiagnosticsRegistry();

export function getDiagnosticsSummary(): DiagnosticsSummary {
  return diagnostics.getDiagnosticsSummary();
}

export function trackActiveTask(taskId: string, description?: string): () => void {
  return diagnostics.trackActiveTask(taskId, description);
}

export function trackActiveAgent(agentId: string, name?: string): () => void {
  return diagnostics.trackActiveAgent(agentId, name);
}

export function trackActiveSubagent(subagentId: string, title?: string): () => void {
  return diagnostics.trackActiveSubagent(subagentId, title);
}

export function recordProviderHealth(provider: string, health: ProviderHealth): void {
  diagnostics.recordProviderHealth(provider, health);
}

export function recordKeyPoolHealth(pool: KeyPoolHealth): void {
  diagnostics.recordKeyPoolHealth(pool);
}

export function recordFailure(error: unknown, context?: Record<string, unknown>): void {
  diagnostics.recordFailure(error, context);
}

export function recordRetryActivity(details: {
  provider?: string;
  attempt: number;
  delayMs?: number;
  error?: string;
}): void {
  diagnostics.recordRetryActivity(details);
}

export function recordFallbackActivity(details: {
  fromProvider: string;
  toProvider: string;
  reason: string;
}): void {
  diagnostics.recordFallbackActivity(details);
}

export function resetDiagnostics(): void {
  diagnostics.resetDiagnostics();
}
