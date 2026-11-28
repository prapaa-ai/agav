import React, { useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "../ink/index.js";
import { HoverText, usePointerMotion } from "./hover-text.js";

/**
 * Normalizes a pasted token count to plain digits. Accepts plain digits and
 * correctly comma-grouped integers such as `32,768`, the form model cards and
 * this prompt display; returns null for anything else, including malformed
 * grouping such as `32,76`.
 */
export function normalizePastedTokens(text: string): string | null {
  if (/^[0-9]+$/.test(text)) return text;
  if (/^[0-9]{1,3}(,[0-9]{3})+$/.test(text)) return text.replace(/,/g, "");
  return null;
}

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
  usePointerMotion();
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
  const submitDefault = () => finish();
  const confirm = () => {
    if (finished.current) return;
    const trimmed = valueRef.current.trim();
    if (!trimmed) { submitDefault(); return; }
    const parsed = Number(trimmed.replace(/[,_]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a positive number of tokens, or press Esc to use the default.");
      return;
    }
    finish(Math.floor(parsed));
  };

  useInput((input, key) => {
    if (finished.current) return;
    if (key.escape) submitDefault();
    else if (key.return) confirm();
    else if (key.backspace || key.delete) updateValue(valueRef.current.slice(0, -1));
    // Digits only — this is a token count, not free text.
    else if (/^[0-9]+$/.test(input)) updateValue(valueRef.current + input);
  });

  usePaste((text) => {
    if (finished.current) return;
    const digits = normalizePastedTokens(text);
    if (digits === null) {
      setError("Enter digits only, or press Esc to use the default.");
      return;
    }
    updateValue(valueRef.current + digits);
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
        <HoverText onClick={confirm}>Enter to confirm</HoverText>
        <Text dimColor> · </Text>
        <HoverText onClick={submitDefault}>Esc to use default ({defaultValue.toLocaleString()})</HoverText>
      </Box>
    </Box>
  );
}
