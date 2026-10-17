import { describe, expect, it } from "vitest";
import { cleanVoiceTranscript } from "../utils/voice-transcript.js";

describe("voice recognition artifact filtering", () => {
  it.each(["[BLANK_AUDIO]", "[blank audio]", "(silence)", "[NO_SPEECH]", "[Music]", "(applause)", "[laughter]", "[inaudible]", "[background noise]", "<|nospeech|>", "<|endoftext|>", "<|0.00|>", "♪ ♫"])("removes annotation-only %s", annotation => {
    expect(cleanVoiceTranscript(annotation)).toBe("");
  });
  it("retains speech around annotations", () => {
    expect(cleanVoiceTranscript("[BLANK_AUDIO] explain [inaudible] parser (music) then add tests <|endoftext|>")).toBe("explain parser then add tests");
  });
  it.each(["(inaudible speech)", "[foreign language]", "(whooshing)", "[wind]", "(rustling)", "[static]", "(whispering)"]) ("removes extended Whisper noise annotation %s", annotation => {
    expect(cleanVoiceTranscript(`please explain ${annotation} parser`)).toBe("please explain parser");
  });
  it.each(["Use [index] and (value)", "The music player handles silence", "Set BLANK_AUDIO to false", "console.log(items[0])", "Keep [custom annotation] unchanged"])("preserves informational text %s", text => {
    expect(cleanVoiceTranscript(text)).toBe(text);
  });
});
