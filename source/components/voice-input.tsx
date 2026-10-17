import React from "react";
import { Box, Text } from "../ink/index.js";
import { wrapToWidth } from "../utils/wrap-text.js";
import type { VoiceUIPhase } from "../hooks/use-voice-input.js";

interface Props {
  phase: Exclude<VoiceUIPhase, "model-consent" | "downloading">;
  elapsedSeconds: number;
  level: number;
  partialText?: string;
  columns: number;
  onStop: () => void;
  onCancel: () => void;
}

/** Bounded, text-labelled controls; levels reflect captured PCM, never animation. */
export default function VoiceInputPanel({ phase, elapsedSeconds, level, partialText = "", columns, onStop, onCancel }: Props) {
  const narrow = columns < 48;
  const tiny = columns < 28;
  const seconds = Math.min(120, Math.max(0, Math.floor(elapsedSeconds)));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const labels = { preparing: "Preparing microphone", recording: "Listening", stopping: "Stopping microphone", transcribing: "Transcribing locally", cancelling: "Cancelling" };
  const title = tiny ? { preparing: "Preparing", recording: "Listening", stopping: "Stopping", transcribing: "Transcribing", cancelling: "Cancelling" }[phase] : labels[phase];
  const count = narrow ? 6 : 12;
  const filled = Math.round(Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * count);
  return <Box flexDirection="column" marginTop={1}>
    <Text bold color={phase === "recording" ? "cyan" : "yellow"}>Voice · {title}</Text>
    {phase === "recording" ? <Text>{`[${"|".repeat(filled)}${".".repeat(count - filled)}] ${elapsed}${tiny ? "" : " / 2:00"}`}</Text> :
      <Text dimColor>{tiny ? "Audio stays local" : "Audio stays on this machine"}</Text>}
    {partialText && <Text>{wrapToWidth(partialText, Math.max(1, columns)).slice(-3).join("\n")}</Text>}
    <Box>
      {phase === "recording" && <Text color="cyan" onClick={onStop}>{tiny ? "Stop" : "click Stop to edit"}</Text>}
      {phase === "recording" && <Text>{tiny ? " " : " · "}</Text>}
      {phase !== "cancelling" && <Text onClick={onCancel}>{tiny ? "Esc back" : "Esc cancel / Cancel"}</Text>}
      {phase === "cancelling" && <Text dimColor>{narrow ? "Releasing mic..." : "Releasing microphone and local processes..."}</Text>}
    </Box>
    {!narrow && <Text dimColor>{phase === "recording" ? "Enter sends draft · Ctrl+C cancels" : "Your typed prompt is preserved · Ctrl+C cancels"}</Text>}
  </Box>;
}
