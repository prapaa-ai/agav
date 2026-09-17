import { redactString, redactSecrets } from "./redaction.js";

/**
 * Standard error categories for provider operations, agent execution,
 * network calls, validation, and subagent orchestration.
 */
export enum ErrorCategory {
  Authentication = "Authentication",
  RateLimit = "RateLimit",
  Timeout = "Timeout",
  Network = "Network",
  Provider = "Provider",
  Validation = "Validation",
  Configuration = "Configuration",
  Task = "Task",
  Cancellation = "Cancellation",
  Internal = "Internal",
  NonRetryable = "NonRetryable",
}

/** Determine default retryability based on category and optional HTTP status code. */
export function isCategoryRetryable(category: ErrorCategory, status?: number): boolean {
  if (category === ErrorCategory.NonRetryable) return false;
  if (category === ErrorCategory.Cancellation) return false;
  if (category === ErrorCategory.Authentication) return false;
  if (category === ErrorCategory.Validation) return false;
  if (category === ErrorCategory.Configuration) return false;

  if (category === ErrorCategory.RateLimit) return true;
  if (category === ErrorCategory.Network) return true;
  if (category === ErrorCategory.Timeout) return true;

  if (category === ErrorCategory.Provider) {
    if (status !== undefined) {
      return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
    }
    return true;
  }

  return false;
}

/**
 * Classify an unknown error into one of the standard ErrorCategory enum values.
 */
export function classifyError(err: unknown): ErrorCategory {
  if (!err) {
    return ErrorCategory.Internal;
  }

  if (err instanceof CategorizedError) {
    return err.category;
  }

  // Check cancellation / abort
  if (
    (err as any)?.name === "AbortError" ||
    (err as any)?.code === "ABORT_ERR" ||
    /aborted|cancelled|canceled|user interrupted/i.test(String((err as any)?.message ?? ""))
  ) {
    return ErrorCategory.Cancellation;
  }

  // Inspect HTTP status code
  const status = (err as any)?.status ?? (err as any)?.statusCode ?? (err as any)?.response?.status;
  if (typeof status === "number") {
    if (status === 401 || status === 403) return ErrorCategory.Authentication;
    if (status === 429) return ErrorCategory.RateLimit;
    if (status === 408 || status === 504) return ErrorCategory.Timeout;
    if (status === 400 || status === 422) return ErrorCategory.Validation;
    if (status === 500 || status === 502 || status === 503 || status === 529) return ErrorCategory.Provider;
  }

  // Inspect system error code
  const code = String((err as any)?.code ?? "").toUpperCase();
  if (code.includes("ETIMEDOUT") || code.includes("ESOCKETTIMEDOUT") || code.includes("TIMEOUT")) {
    return ErrorCategory.Timeout;
  }
  if (
    code.includes("ECONNRESET") ||
    code.includes("ECONNREFUSED") ||
    code.includes("ENOTFOUND") ||
    code.includes("EAI_AGAIN") ||
    code.includes("EHOSTUNREACH") ||
    code.includes("EPIPE")
  ) {
    return ErrorCategory.Network;
  }

  // Inspect error message
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  if (/non-?retryable/i.test(msg)) {
    return ErrorCategory.NonRetryable;
  }
  if (/rate\s*limit|quota|too\s*many\s*requests|resource\s*exhausted|exhausted|tpm|rpm/i.test(msg)) {
    return ErrorCategory.RateLimit;
  }
  if (/unauthorized|unauthenticated|forbidden|invalid.*api.*key|api.*key.*invalid|invalid.*token|permission\s*denied|auth\s*failed/i.test(msg)) {
    return ErrorCategory.Authentication;
  }
  if (/timed?\s*out|timeout|deadline\s*exceeded/i.test(msg)) {
    return ErrorCategory.Timeout;
  }
  if (/fetch\s*failed|network\s*error|socket\s*hang\s*up|connection\s*reset|connection\s*refused/i.test(msg)) {
    return ErrorCategory.Network;
  }
  if (/internal\s*server\s*error|overloaded|service\s*unavailable|bad\s*gateway|502|503|529/i.test(msg)) {
    return ErrorCategory.Provider;
  }
  if (/validation|invalid\s*argument|schema\s*validation|bad\s*request/i.test(msg)) {
    return ErrorCategory.Validation;
  }
  if (/missing\s*config|invalid\s*config|configuration\s*error|environment\s*variable/i.test(msg)) {
    return ErrorCategory.Configuration;
  }
  if (/subagent\s*error|task\s*failed|subagent\s*failed/i.test(msg)) {
    return ErrorCategory.Task;
  }

  return ErrorCategory.Internal;
}

export interface CategorizedErrorOptions {
  message: string;
  category?: ErrorCategory;
  retryable?: boolean;
  cause?: unknown;
  code?: string;
  status?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Structured error wrapper carrying categorization, retryable flags,
 * cause, and strictly redacted message.
 */
export class CategorizedError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly originalMessage: string;
  readonly code?: string;
  readonly status?: number;
  readonly metadata?: Record<string, unknown>;

  constructor(options: CategorizedErrorOptions) {
    const rawMessage = options.message || "Unknown error";
    const redactedMessage = redactString(rawMessage);

    super(redactedMessage, {
      cause: options.cause !== undefined ? redactSecrets(options.cause) : undefined,
    });

    this.name = "CategorizedError";
    this.originalMessage = rawMessage;
    this.code = options.code;
    this.status = options.status;
    this.category =
      options.category ??
      classifyError({
        message: rawMessage,
        code: options.code,
        status: options.status,
      });

    this.retryable = options.retryable ?? isCategoryRetryable(this.category, options.status);
    this.metadata = options.metadata ? (redactSecrets(options.metadata) as Record<string, unknown>) : undefined;

    if (this.stack) {
      this.stack = redactString(this.stack);
    }
  }

  static from(err: unknown, overrideCategory?: ErrorCategory): CategorizedError {
    if (err instanceof CategorizedError) {
      if (!overrideCategory || err.category === overrideCategory) {
        return err;
      }
      return new CategorizedError({
        message: err.originalMessage,
        category: overrideCategory,
        retryable: isCategoryRetryable(overrideCategory, err.status),
        cause: err.cause,
        code: err.code,
        status: err.status,
        metadata: err.metadata,
      });
    }

    const message = err instanceof Error ? err.message : String(err ?? "Unknown error");
    const code = (err as any)?.code;
    const status = (err as any)?.status ?? (err as any)?.statusCode;
    const cause = err instanceof Error ? (err as any).cause : undefined;

    return new CategorizedError({
      message,
      category: overrideCategory ?? classifyError(err),
      cause,
      code,
      status,
    });
  }
}
