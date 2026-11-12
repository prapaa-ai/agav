export const claudeThinkingEvents = [
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "initial ", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "encrypted" } },
  { type: "content_block_stop", index: 1 },
];
export const thinkingBlocks = [
  { type: "thinking", thinking: "initial thought", signature: "signed-opaque" },
  { type: "redacted_thinking", data: "encrypted" },
];
