import React, { useMemo } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { renderMarkdown } from "./markdown-text.js";
import { terminalRelativePaths } from "../utils/display-path.js";

/** Props for the streaming assistant response view. */
interface Props {
  text: string;
  thinkingText: string;
  isLoading: boolean;
  showThinking?: boolean;
}

/** Displays streaming output, including thinking and typing states. */
export default function StreamingResponse({ text, thinkingText, isLoading, showThinking }: Props) {
  // Hooks run before any early return — bailing out first would change the hook
  // count between renders and crash the reconciler.
  const rendered = useMemo(() => {
    if (!text) return "";
    return renderMarkdown(terminalRelativePaths(text));
  }, [text]);

  const renderedThinking = useMemo(() => {
    if (!thinkingText) return "";
    const truncated = thinkingText.length > 500
      ? thinkingText.slice(-500).trimStart()
      : thinkingText;
    return renderMarkdown(terminalRelativePaths(truncated));
  }, [thinkingText]);

  if (!isLoading && !text && !thinkingText) {
    return null;
  }

  const isThinking = isLoading && thinkingText && !text;

  return (
    <Box flexDirection="column">
      {isLoading && !text && !thinkingText ? (
        <Box>
          <Text dimColor>{"  "}</Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Thinking...</Text>
        </Box>
      ) : null}
      {isThinking ? (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{"  "}</Text>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text dimColor> Thinking ({thinkingText.length} chars)...</Text>
          </Box>
          {showThinking ? (
            <Box paddingLeft={2} marginTop={1}>
              <Text dimColor wrap="wrap">
                {renderedThinking}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {rendered ? <Text>{"  "}{rendered}</Text> : null}
      {isLoading && text ? (
        <Text dimColor>{"  "}▊</Text>
      ) : null}
    </Box>
  );
}
