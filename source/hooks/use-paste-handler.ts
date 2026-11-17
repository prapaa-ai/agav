import { usePaste } from "../ink/index.js";
import { getClipboardImage, type ClipboardImage } from "../utils/clipboard-image.js";

const PASTE_THRESHOLD = 50;

export function useClipboardImageDetector(
  onImage: (img: ClipboardImage) => void,
  enabled: boolean,
  onText?: (text: string) => void,
  onInsertRaw?: (text: string) => void,
) {
  usePaste((text) => {
    // Terminals can send CR or CRLF for pasted line breaks. Normalize before
    // routing or repeat-paste tracking so raw CR never reaches the composer
    // (where it would overwrite the current terminal row instead of wrapping).
    text = text.replace(/\r\n?/g, "\n");
    if (text.length === 0) {
      getClipboardImage().then((img) => {
        if (img) onImage(img);
      });
    } else if (!text.includes("\n") && /^https?:\/\//.test(text) && onInsertRaw) {
      onInsertRaw(text);
    } else if (text.length >= PASTE_THRESHOLD && onText) {
      onText(text);
    } else if (onInsertRaw) {
      onInsertRaw(text);
    }
  }, { isActive: enabled });
}
