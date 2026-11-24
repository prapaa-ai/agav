import React from "react";
import { stripVTControlCharacters } from "node:util";
import { Text } from "../ink/index.js";
import { terminalRelativePaths } from "../utils/display-path.js";
import { visualLen } from "../utils/wrap-text.js";

export interface SessionNotice {
  severity: "error" | "warning";
  text: string;
}

export function formatSessionNotice({ severity, text }: SessionNotice): string {
  const label = severity === "error" ? "Error" : "Warning";
  const plain = terminalRelativePaths(stripVTControlCharacters(text).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")).trim();
  // Some sources already include a severity prefix (e.g. startup warnings).
  return new RegExp(`^${label}:`, "i").test(plain) ? plain : `${label}: ${plain}`;
}

/** One reserved footer row: notices never resize the transcript or take input. */
export default function SessionNoticeLine({ notices, columns }: { notices: SessionNotice[]; columns: number }) {
  const latest = notices[0];
  if (!latest) return <Text> </Text>;

  const summary = formatSessionNotice(latest).replace(/\s+/g, " ");
  const hasDetails = notices.length > 1 || visualLen(summary) > columns;
  const label = latest.severity === "error" ? "Error" : "Warning";
  const text = hasDetails ? `${label} · /notices: ${summary.slice(label.length + 1).trimStart()}` : summary;
  return <Text color={latest.severity === "error" ? "red" : "yellow"} wrap="truncate-end">{text}</Text>;
}
