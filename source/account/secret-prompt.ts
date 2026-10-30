import { getClipboardText } from "../utils/clipboard-text.js";

/** Isolated no-echo input. The caller suspends Ink until this promise settles. */
export interface SecretPromptOptions {
  label: string;
  signal?: AbortSignal;
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  /** Ink keeps paste enabled; a standalone CLI restores it to disabled. */
  restoreBracketedPaste?: "enabled" | "disabled";
}

export class SecretPromptError extends Error {}

const START = "\x1b[200~";
const END = "\x1b[201~";

/**
 * One incremental parser owns input through normal entry AND cancellation.
 * There is deliberately no quiet/recovery timer: silence is not a frame boundary.
 * A bare Escape is ambiguous with a delayed paste opening, so Esc+Enter confirms
 * cancellation. Ctrl-C cancels immediately outside a frame. Inside a frame it
 * discards the secret but retains input ownership until the closing marker/EOF.
 * If a terminal never finishes a frame, it must close the input/session; handing
 * unfinished input to the composer would expose any subsequently arriving tail.
 */
export function readSecretFromTty(options: SecretPromptOptions): Promise<string | undefined> {
  const input = options.input ?? process.stdin;
  const out = options.out ?? process.stdout;
  return new Promise((resolve, reject) => {
    let secret = "";
    let sequence = "";
    let inPaste = false;
    let cancelled = false;
    let submitted = false;
    let settled = false;
    let pasteEnabled = false;
    let clipboardPending = false;
    let queuedInput = "";
    const hadRaw = input.isRaw ?? false;

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      options.signal?.removeEventListener("abort", onAbort);
      if (pasteEnabled) {
        try { out.write(options.restoreBracketedPaste === "disabled" ? "\x1b[?2004l" : "\x1b[?2004h"); } catch { /* terminal closed */ }
      }
      try { if (!hadRaw && input.isTTY) input.setRawMode(false); } catch { /* terminal closed */ }
      input.pause();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      const value = cancelled ? undefined : secret;
      secret = "";
      sequence = "";
      queuedInput = "";
      cleanup();
      try { out.write("\n"); } catch { /* terminal closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => {
      if (!cancelled) {
        cancelled = true;
        secret = "";
        if (inPaste || sequence) out.write("\nSign-in cancelled; waiting for the paste/control sequence to finish.\n");
      }
    };
    const maybeFinish = () => {
      // Process the complete chunk first: END followed by START in the same read
      // still leaves an open frame that we must not hand to the next consumer.
      if (!inPaste && !sequence && (cancelled || (submitted && !clipboardPending))) finish();
    };
    const drainQueuedInput = () => {
      const queued = queuedInput;
      queuedInput = "";
      for (const ch of queued) consume(ch);
    };
    const onAbort = () => { cancel(); drainQueuedInput(); maybeFinish(); };
    const onError = () => { cancel(); finish(new SecretPromptError("Terminal input failed.")); };
    const onEnd = () => { cancel(); finish(); };

    const append = (ch: string) => {
      if (cancelled || submitted) return;
      if (ch >= " " && ch !== "\x7f") {
        secret += ch;
        out.write("*");
      }
    };
    const consume = (ch: string): void => {
      if (ch === "\x03") {
        // Do not lose an incomplete marker when cancellation interrupts it.
        cancel();
        return;
      }
      // Preserve input order while the OS clipboard read is asynchronous.
      // Cancellation remains live and still drains the bracketed-paste parser.
      if (clipboardPending && !cancelled && ch !== "\x03") { queuedInput += ch; return; }
      if (cancelled && queuedInput) drainQueuedInput();
      if (sequence) {
        // A user pressing Esc then Enter explicitly resolves the ambiguity. Never
        // interpret Enter inside a paste as confirmation (it may be pasted data).
        if (sequence === "\x1b" && !inPaste && (ch === "\r" || ch === "\n")) {
          sequence = "";
          cancel();
          return;
        }
        sequence += ch;
        const marker = inPaste ? END : START;
        if (sequence === marker) {
          inPaste = !inPaste;
          sequence = "";
          return;
        }
        if (marker.startsWith(sequence)) return;
        // Ignore complete non-paste CSI keys (arrows etc.), retaining split
        // sequences until their final byte rather than exposing their tail.
        if (sequence.startsWith("\x1b[") && !/[\x40-\x7e]$/.test(sequence.slice(2))) return;
        // Preserve a new Escape that might begin a split closing marker.
        sequence = ch === "\x1b" ? "\x1b" : "";
        return;
      }
      if (ch === "\x1b") {
        sequence = ch;
        return;
      }
      if (inPaste) { append(ch); return; }
      if (ch === "\x16" && !cancelled && !submitted) {
        // Native Windows consoles may deliver Ctrl-V rather than pasted bytes.
        // Read text only: never send the key to composer/attachment handlers.
        clipboardPending = true;
        void (async () => {
          try {
            const text = await getClipboardText();
            if (!settled && !cancelled && text) {
              // Clipboard controls are data, not terminal commands (notably the
              // CRLF added by PowerShell's Get-Clipboard must not submit).
              for (const c of text) append(c);
            }
          } catch { /* Clipboard unavailable; keep manual entry usable. */ }
          finally {
            clipboardPending = false;
            if (!settled) { drainQueuedInput(); maybeFinish(); }
          }
        })();
        return;
      }
      if (ch === "\r" || ch === "\n") { submitted = true; return; }
      if (ch === "\x7f" || ch === "\b") {
        if (!cancelled && !submitted && secret.length) {
          secret = secret.slice(0, -1);
          out.write("\b \b");
        }
        return;
      }
      append(ch);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      for (const ch of chunk.toString()) consume(ch);
      if (cancelled) drainQueuedInput();
      maybeFinish();
    };

    try {
      if (!input.isTTY) throw new SecretPromptError("Secret input requires an interactive terminal.");
      input.setRawMode(true); // Fail closed before accepting any secret input.
      out.write("\x1b[?2004h");
      pasteEnabled = true;
      out.write("Ctrl-C cancels; Esc then Enter also cancels. An unfinished paste remains isolated until its closing marker or EOF.\n" + options.label);
      input.on("data", onData);
      input.on("error", onError);
      input.once("end", onEnd);
      input.once("close", onEnd);
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
      if (!settled) {
        if (input.readableEnded || input.destroyed) onEnd();
        else input.resume();
      }
    } catch {
      cancelled = true;
      finish(new SecretPromptError("Could not establish secure terminal input."));
    }
  });
}
