import { usePaste } from "ink";
import { getClipboardImage, type ClipboardImage } from "../utils/clipboard-image.js";

const PASTE_THRESHOLD = 50;

export function useClipboardImageDetector(
  onImage: (img: ClipboardImage) => void,
  enabled: boolean,
  onText?: (text: string) => void,
  onInsertRaw?: (text: string) => void,
) {
  usePaste((text) => {
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
