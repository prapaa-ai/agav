import React, { useRef, useState } from "react";
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
  const valueRef = useRef(value);
  const finished = useRef(false);
  const updateValue = (next: string) => {
    valueRef.current = next;
    setValue(next);
    setError(null);
  };
  const finish = (tokens?: number) => {
    if (finished.current) return;
    finished.current = true;
    onSubmit(tokens);
  };
  const useDefault = () => finish();
  const confirm = () => {
    if (finished.current) return;
    const trimmed = valueRef.current.trim();
    if (!trimmed) { useDefault(); return; }
    const parsed = Number(trimmed.replace(/[,_]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a positive number of tokens, or press Esc to use the default.");
      return;
    }
    finish(Math.floor(parsed));
  };

  useInput((input, key) => {
    if (finished.current) return;
    if (key.escape) useDefault();
    else if (key.return) confirm();
    else if (key.backspace || key.delete) updateValue(valueRef.current.slice(0, -1));
    // Digits only — this is a token count, not free text.
    else if (/^[0-9]+$/.test(input)) updateValue(valueRef.current + input);
  });

  usePaste((text) => {
    if (finished.current) return;
    if (!/^[0-9]+$/.test(text)) {
      setError("Enter digits only, or press Esc to use the default.");
      return;
    }
    updateValue(valueRef.current + text);
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
      <Box marginTop={1} flexWrap="wrap">
        <Text underline onClick={confirm}>Enter to confirm</Text>
        <Text dimColor> · </Text>
        <Text underline onClick={useDefault}>Esc to use default ({defaultValue.toLocaleString()})</Text>
      </Box>
    </Box>
  );
}
