import { useEffect, useState } from "react";
import { detectTargets, type DetectedTarget } from "../utils/detect-targets.js";

/**
 * Detect URLs and existing file paths in `text`, memoised per `cacheKey`
 * (typically a message id) so the (async, filesystem-touching) detection
 * runs once per message rather than on every render.
 *
 * Returns `[]` until detection resolves — callers render plain text in the
 * meantime, which is indistinguishable from "nothing detected" and never
 * shows a stale or half-applied result.
 */
export function useDetectedTargets(text: string, cacheKey: string | undefined, enabled: boolean): DetectedTarget[] {
  const [targets, setTargets] = useState<DetectedTarget[]>([]);

  useEffect(() => {
    if (!enabled || !text) {
      setTargets([]);
      return;
    }
    // Do not apply ranges from the previous text while a streaming update is
    // being scanned; those offsets can point at unrelated content.
    setTargets([]);
    let cancelled = false;
    detectTargets(text, process.cwd(), cacheKey).then((found) => {
      if (!cancelled) setTargets(found);
    }).catch(() => {
      if (!cancelled) setTargets([]);
    });
    return () => { cancelled = true; };
  }, [text, cacheKey, enabled]);

  return targets;
}
