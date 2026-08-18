/**
 * Runtime detection for the Kitty keyboard protocol.
 *
 * Without it, Shift+Enter is indistinguishable from Enter: the legacy encoding
 * transmits a bare `\r` for both. Ink can negotiate the protocol, but only tells
 * the terminal — it never reports back whether the terminal agreed, and the UI
 * needs to know so it does not advertise a key that cannot work here.
 *
 * So we run the query ourselves before Ink starts, then hand Ink the answer as an
 * explicit `enabled`/`disabled` mode instead of letting it probe a second time.
 *
 * @see https://sw.kovidgoyal.net/kitty/keyboard-protocol/
 */

/** `CSI ? <flags> u` — a terminal that speaks the protocol answers the query with this. */
const REPLY_RE = /\x1b\[\?\d*u/;

/** A reply still arriving when the timeout fires. Dropped rather than replayed as input. */
const PARTIAL_REPLY_RE = /\x1b(?:\[(?:\?[\d;]*)?)?$/;

const ENV_FLAG = "AGAV_KITTY_KEYBOARD";

export interface DetectKittyKeyboardOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** How long to wait for a reply. Terminals without support simply never answer. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Read the escape hatch for terminals that answer the query but mishandle the protocol. */
function readOverride(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[ENV_FLAG]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  return undefined;
}

/**
 * Ask the terminal whether it supports the Kitty keyboard protocol.
 *
 * Resolves `false` for anything that cannot answer — a pipe, a CI runner, a dumb
 * terminal — rather than stalling for the timeout. Never throws, never leaves the
 * terminal in a different state than it found it, and unshifts anything the user
 * typed during the probe so no keystroke is swallowed.
 */
export async function detectKittyKeyboard(options: DetectKittyKeyboardOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const override = readOverride(env);
  if (override !== undefined) return override;

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const timeoutMs = options.timeoutMs ?? 200;

  // Probing a stream that cannot reply just writes the query somewhere it will be
  // echoed back at the user as text.
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (typeof stdin.setRawMode !== "function") return false;
  if (env["CI"]) return false;
  if (env["TERM"] === "dumb") return false;

  return await new Promise<boolean>((resolve) => {
    const wasRaw = stdin.isRaw === true;
    const wasPaused = stdin.isPaused();
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    // latin1 round-trips arbitrary bytes through a string losslessly, which lets
    // the reply be matched and stripped without corrupting real keystrokes.
    const onData = (data: Buffer | string): void => {
      chunks.push(typeof data === "string" ? Buffer.from(data, "latin1") : data);
      if (REPLY_RE.test(Buffer.concat(chunks).toString("latin1"))) finish(true);
    };

    const finish = (supported: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdin.removeListener("data", onData);

      try {
        const leftover = Buffer.concat(chunks)
          .toString("latin1")
          .replace(REPLY_RE, "")
          .replace(PARTIAL_REPLY_RE, "");
        // Stop the flow before putting bytes back. Attaching the listener resumed
        // the stream, and an unshift into a flowing stream with no listener left on
        // it is discarded rather than buffered.
        stdin.pause();
        if (leftover.length > 0) stdin.unshift(Buffer.from(leftover, "latin1"));
        if (!wasRaw) stdin.setRawMode(false);
        if (!wasPaused) stdin.resume();
      } catch {
        // Restoring is best effort — a failure here must not take down startup.
      }

      resolve(supported);
    };

    try {
      if (!wasRaw) stdin.setRawMode(true);
      // Attach before writing so an immediate reply is not missed.
      stdin.on("data", onData);
      // Deliberately not unref'd: the timer is the only thing that ends the probe,
      // and letting the loop drain out from under it would strand the promise.
      timer = setTimeout(() => finish(false), timeoutMs);
      stdout.write("\x1b[?u");
    } catch {
      finish(false);
    }
  });
}
