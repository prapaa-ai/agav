import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "../ink/index.js";

interface Props {
  model: string;
  defaultValue: number;
  onSubmit: (tokens: number | undefined) => void;
}

/**
 * Asks the user for a model's context window when the provider confirmed it
 * cannot report one — OpenRouter stealth models being the motivating case,
 * deliberately excluded from the public catalog. Enter submits the typed
 * value (or the default shown if left blank); Esc skips straight to the
 * default without requiring the user to type it out.
 */
export default function ContextWindowPrompt({ model, defaultValue, onSubmit }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onSubmit(undefined);
      return;
    }
    if (key.return) {
      const trimmed = value.trim();
      if (!trimmed) {
        onSubmit(undefined);
        return;
      }
      const parsed = Number(trimmed.replace(/[,_]/g, ""));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setError("Enter a positive number of tokens, or press Esc to use the default.");
        return;
      }
      onSubmit(Math.floor(parsed));
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      setError(null);
      return;
    }
    // Digits only — this is a token count, not free text.
    if (/^[0-9]+$/.test(input)) {
      setValue((prev) => prev + input);
      setError(null);
    }
  });

  usePaste((text) => {
    if (!/^[0-9]+$/.test(text)) {
      setError("Enter digits only, or press Esc to use the default.");
      return;
    }
    setValue((prev) => prev + text);
    setError(null);
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="yellow">
        Unknown context window for {model}
      </Text>
      <Text dimColor>
        This model was not found in its provider's catalog — likely a stealth or
        unlisted model. Enter its real context window in tokens, or press Esc to
        assume {defaultValue.toLocaleString()}.
      </Text>
      <Box marginTop={1}>
        <Text>Context window (tokens): </Text>
        <Text color="cyan">{value}</Text>
        <Text color="cyan">█</Text>
      </Box>
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1}>
        <Text dimColor>Enter to confirm · Esc to use default ({defaultValue.toLocaleString()})</Text>
      </Box>
    </Box>
  );
}
