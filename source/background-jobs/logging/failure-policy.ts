/**
 * Pure decision only: it never stops or signals anything; the supervisor acts on the result.
 * `request-stop-and-drain` is the only policy implemented.
 */
export type LoggingFailurePolicy = "request-stop-and-drain";

export interface LoggingFailureAction {
  action: "request-stop";
  drainBehavior: "discard-after-stop";
  diagnostic: string;
}

export function describeLoggingFailureAction(reason: string): LoggingFailureAction {
  return {
    action: "request-stop",
    drainBehavior: "discard-after-stop",
    diagnostic: `logging failure, requesting stop: ${reason}`,
  };
}
