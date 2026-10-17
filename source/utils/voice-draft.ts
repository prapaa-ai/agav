/** Track recognition separately from visible text: corrections rebase without deleting user words. */
export function advanceVoiceDraft(previous: string, next: string): { accepted: string; suffix: string } {
  const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
  const key = (word: string) => word.toLowerCase().replace(/[.,!?;:]+$/u, "");
  const before = words(previous);
  const after = words(next);
  if (!after.length) return { accepted: previous, suffix: "" };
  if (!before.length) return { accepted: next.trim(), suffix: next.trim() };
  // Only newly spoken trailing words are appended. Empty, shorter or rewritten
  // hypotheses cannot erase visible words or replay a user-deleted prefix.
  const related = key(before[0]) === key(after[0]) ||
    (before.length === after.length && key(before[before.length - 1]) === key(after[after.length - 1]));
  if (after.length <= before.length) {
    const backtrack = after.every((word, index) => key(word) === key(before[index]));
    return { accepted: backtrack || !related ? previous : next.trim(), suffix: "" };
  }
  let matched = 0;
  for (let index = 0; index < after.length; index++) {
    if (key(after[index]) === key(before[matched])) matched++;
    if (matched === before.length) {
      const suffix = after.slice(index + 1).join(" ");
      return { accepted: suffix ? `${previous.trimEnd()} ${suffix}` : previous, suffix };
    }
  }
  // A revised prefix must become the comparison baseline, not a permanent
  // barrier to later speech. This does not replace the visible/user-owned draft.
  return { accepted: related ? next.trim() : previous, suffix: "" };
}
