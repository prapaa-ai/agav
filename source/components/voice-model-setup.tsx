import React from "react";
import { Box, Text } from "../ink/index.js";
import type { DEFAULT_VOICE_MODEL } from "../utils/voice-model.js";

interface Props {
  model: typeof DEFAULT_VOICE_MODEL;
  downloading: boolean;
  bytes: number;
  onDownload: () => void;
  onCancel: () => void;
}

/** No network or microphone access until the user explicitly confirms. */
export default function VoiceModelSetup({ model, downloading, bytes, onDownload, onCancel }: Props) {
  const total = model.size;
  const size = `${(total / 1_000_000).toFixed(1)} MB (${total.toLocaleString("en-US")} bytes)`;
  const received = Math.max(0, Math.min(total, bytes));
  return <Box flexDirection="column" marginTop={1}>
    <Text bold color="cyan">Voice · {downloading ? "Downloading voice setup" : "Local voice setup"}</Text>
    <Text>{model.name} · {size}</Text>
    <Text dimColor>{model.url}</Text>
    <Text dimColor>Native voice helper included in Agav · no runtime download</Text>
    <Text>Total download: {size}</Text>
    {downloading ? <Text>{Math.floor(received / total * 100)}% · {(received / 1_000_000).toFixed(1)} / {(total / 1_000_000).toFixed(1)} MB · SHA-256 verified before install</Text> : <>
      <Text>Download to ~/.agav/voice? Audio transcription stays local.</Text>
      <Text dimColor>Advanced: AGAV_VOICE_MODEL / AGAV_VOICE_HELPER_BIN select existing local files.</Text>
    </>}
    <Box>
      {!downloading && <><Text color="cyan" onClick={onDownload}>Y download</Text><Text> · </Text></>}
      <Text onClick={onCancel}>{downloading ? "Esc cancel" : "N / Esc cancel"}</Text>
    </Box>
    {!downloading && <Text dimColor>No external tools to install. Recording starts after setup.</Text>}
  </Box>;
}
