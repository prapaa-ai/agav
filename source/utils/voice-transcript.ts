/** Remove only known recognizer annotations, never arbitrary bracketed/code text. */
export function cleanVoiceTranscript(text: string): string {
  const annotation = "(?:blank[ _-]*audio|no[ _-]*speech|silence|silent|music|background[ _-]*music|applause|clapping|laughter|laughing|inaudible|unintelligible|noise|background[ _-]*noise|sighs?|coughs?|breathing)";
  return text
    .replace(new RegExp(`\\[\\s*${annotation}\\s*\\]|\\(\\s*${annotation}\\s*\\)`, "gi"), " ")
    .replace(/<\|(?:endoftext|startoftranscript|nospeech|notimestamps|endofsegment|startofprev|startoflm|transcribe|translate|en|\d+(?:\.\d+)?)\|>/gi, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/\s+/g, " ").trim();
}
