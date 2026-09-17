import { getCorrelationContext, type CorrelationContext } from "./correlation.js";
import { redactString, redactSecrets } from "./redaction.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntryError {
  name?: string;
  message: string;
  stack?: string;
  category?: string;
  code?: string;
  status?: number;
  cause?: unknown;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string; // ISO 8601
  level: LogLevel;
  message: string;
  correlationId?: string;
  requestId?: string;
  taskId?: string;
  agentId?: string;
  subagentId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  error?: LogEntryError;
}

export type LogSink = (entry: LogEntry) => void;

export interface LoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
  sinks?: LogSink[];
  maxRecentLogs?: number;
}

export class Logger {
  private level: LogLevel;
  private bindings: Record<string, unknown>;
  private sinks: Set<LogSink>;
  private recentLogs: LogEntry[] = [];
  private maxRecentLogs: number;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.bindings = options.bindings ? (redactSecrets(options.bindings) as Record<string, unknown>) : {};
    this.sinks = new Set(options.sinks ?? []);
    this.maxRecentLogs = options.maxRecentLogs ?? 500;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  addSink(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => this.removeSink(sink);
  }

  removeSink(sink: LogSink): void {
    this.sinks.delete(sink);
  }

  clearLogs(): void {
    this.recentLogs = [];
  }

  getRecentLogs(
    limit?: number,
    filter?: { minLevel?: LogLevel; correlationId?: string; taskId?: string },
  ): LogEntry[] {
    let result = this.recentLogs;

    if (filter) {
      if (filter.minLevel) {
        const minPriority = LOG_LEVEL_PRIORITY[filter.minLevel];
        result = result.filter((e) => LOG_LEVEL_PRIORITY[e.level] >= minPriority);
      }
      if (filter.correlationId) {
        result = result.filter((e) => e.correlationId === filter.correlationId);
      }
      if (filter.taskId) {
        result = result.filter((e) => e.taskId === filter.taskId);
      }
    }

    if (limit !== undefined && limit > 0) {
      return result.slice(-limit);
    }
    return [...result];
  }

  child(bindings: Record<string, unknown>): Logger {
    const redactedBindings = redactSecrets(bindings) as Record<string, unknown>;
    const childLogger = new Logger({
      level: this.level,
      bindings: {
        ...this.bindings,
        ...redactedBindings,
      },
      sinks: Array.from(this.sinks),
      maxRecentLogs: this.maxRecentLogs,
    });

    // Share the ring buffer and sinks with the parent
    childLogger.recentLogs = this.recentLogs;
    childLogger.sinks = this.sinks;

    return childLogger;
  }

  log(level: LogLevel, message: string, metadata?: Record<string, unknown>, error?: unknown): LogEntry {
    const isLevelEnabled = LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];

    const currentContext = getCorrelationContext();

    // Redact text message
    const redactedMessage = redactString(message);

    // Merge and redact metadata with bindings
    let mergedMetadata: Record<string, unknown> | undefined;
    const rawMetadata = {
      ...this.bindings,
      ...(metadata ?? {}),
    };

    // Remove correlation IDs from metadata if they match the context fields
    const correlationId = (rawMetadata.correlationId as string) ?? currentContext?.correlationId;
    const requestId = (rawMetadata.requestId as string) ?? currentContext?.requestId;
    const taskId = (rawMetadata.taskId as string) ?? currentContext?.taskId;
    const agentId = (rawMetadata.agentId as string) ?? currentContext?.agentId;
    const subagentId = (rawMetadata.subagentId as string) ?? currentContext?.subagentId;
    const sessionId = (rawMetadata.sessionId as string) ?? currentContext?.sessionId;

    delete rawMetadata.correlationId;
    delete rawMetadata.requestId;
    delete rawMetadata.taskId;
    delete rawMetadata.agentId;
    delete rawMetadata.subagentId;
    delete rawMetadata.sessionId;

    if (Object.keys(rawMetadata).length > 0) {
      mergedMetadata = redactSecrets(rawMetadata) as Record<string, unknown>;
    }

    // Process and redact error if provided
    let processedError: LogEntryError | undefined;
    if (error !== undefined && error !== null) {
      if (error instanceof Error) {
        processedError = {
          name: error.name,
          message: redactString(error.message),
          stack: error.stack ? redactString(error.stack) : undefined,
          category: (error as any).category,
          code: (error as any).code,
          status: (error as any).status,
          cause: (error as any).cause ? redactSecrets((error as any).cause) : undefined,
        };
      } else if (typeof error === "object") {
        processedError = redactSecrets(error) as LogEntryError;
      } else {
        processedError = {
          message: redactString(String(error)),
        };
      }
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactedMessage,
      ...(correlationId ? { correlationId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(subagentId ? { subagentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(mergedMetadata ? { metadata: mergedMetadata } : {}),
      ...(processedError ? { error: processedError } : {}),
    };

    // Store in recent logs buffer
    this.recentLogs.push(entry);
    if (this.recentLogs.length > this.maxRecentLogs) {
      this.recentLogs.shift();
    }

    // Only dispatch to sinks if enabled by current level
    if (isLevelEnabled) {
      for (const sink of this.sinks) {
        try {
          sink(entry);
        } catch {
          // Prevent sink errors from crashing the logger
        }
      }
    }

    return entry;
  }

  debug(message: string, metadata?: Record<string, unknown>): LogEntry {
    return this.log("debug", message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): LogEntry {
    return this.log("info", message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>, error?: unknown): LogEntry {
    return this.log("warn", message, metadata, error);
  }

  error(message: string, metadata?: Record<string, unknown>, error?: unknown): LogEntry {
    return this.log("error", message, metadata, error);
  }
}

/** Global default logger instance. */
export const logger = new Logger();

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}
