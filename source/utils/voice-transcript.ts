const RECOGNIZER_ANNOTATION_PATTERN =
  "(?:blank[ _-]*audio|no[ _-]*speech|silence|silent|music|background[ _-]*music|applause|clapping|laughter|laughing|inaudible(?: speech)?|unintelligible(?: speech)?|foreign[ _-]*language|speaking[ _-]*foreign[ _-]*language|noise|background[ _-]*noise|whooshing|wind|rustling|static|sighs?|coughs?|breathing|whispering)";

const RECOGNIZER_ANNOTATION_REGEX = new RegExp(
  `\\[\\s*${RECOGNIZER_ANNOTATION_PATTERN}\\s*\\]|\\(\\s*${RECOGNIZER_ANNOTATION_PATTERN}\\s*\\)`,
  "gi",
);

const SPECIAL_TOKEN_REGEX =
  /<\|(?:endoftext|startoftranscript|nospeech|notimestamps|endofsegment|startofprev|startoflm|transcribe|translate|en|\d+(?:\.\d+)?)\|>/gi;

const MUSIC_SYMBOL_REGEX = /[♪♫]+/g;
const WHITESPACE_REGEX = /\s+/g;

/** Remove only known recognizer annotations, never arbitrary bracketed/code text. */
export function cleanVoiceTranscript(text: string): string {
  return text
    .replace(RECOGNIZER_ANNOTATION_REGEX, " ")
    .replace(SPECIAL_TOKEN_REGEX, " ")
    .replace(MUSIC_SYMBOL_REGEX, " ")
    .replace(WHITESPACE_REGEX, " ")
    .trim();
}