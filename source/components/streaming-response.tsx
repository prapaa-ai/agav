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
}

/** Displays streaming output, including thinking and typing states. */
export default function StreamingResponse({ text, thinkingText, isLoading }: Props) {
  if (!isLoading && !text && !thinkingText) {
    return null;
  }

  const rendered = useMemo(() => {
    if (!text) return "";
    return renderMarkdown(terminalRelativePaths(text));
  }, [text]);

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
        <Box>
          <Text dimColor>{"  "}</Text>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text dimColor> Thinking ({thinkingText.length} chars)...</Text>
        </Box>
      ) : null}
      {rendered ? <Text>{"  "}{rendered}</Text> : null}
      {isLoading && text ? (
        <Text dimColor>{"  "}▊</Text>
      ) : null}
    </Box>
  );
}
