import { signInWithApiKey, signOutAccount, parseConsumerArgs } from "../account/account-login.js";
import { readSecretFromTty } from "../account/secret-prompt.js";
import { AccountError } from "../account/types.js";

/**
 * `agav login` / `agav logout --account` — consumer Agav account sign-in from
 * the plain CLI (outside the TUI, which has the full interactive wizard). There
 * is no `--key` flag: the interactive path collects the key through a masked
 * prompt, and scripts pipe it on stdin. Returns a process exit code.
 *
 * Key input:
 *   - a TTY     → masked interactive prompt (hidden as you paste)
 *   - no TTY    → read one line from stdin (e.g. `cat key.txt | agav login`)
 */
export async function runConsumerLoginCli(
  command: "login" | "logout",
  argv: string[],
): Promise<number> {
  const parsed = parseConsumerArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }

  if (command === "logout") {
    try {
      await signOutAccount();
      console.log("Signed out of your Agav account.");
      return 0;
    } catch (error) {
      console.error(
        `Could not sign out of your Agav account: ${error instanceof Error ? error.message : String(error)}\n` +
        "Your account is still connected. Fix the file permissions and try again.",
      );
      return 1;
    }
  }

  // Resolve the key: masked TTY prompt, else one line from stdin (scripting).
  let key: string | undefined;
  if (process.stdin.isTTY) {
    console.log("Sign in to your Agav account. Create or copy a key at https://agav.dev/account.");
    key = await readSecretFromTty({
      label: "Paste your Agav API key, then Enter (hidden): ",
      // Standalone CLI owns the terminal: leave bracketed paste OFF on exit.
      restoreBracketedPaste: "disabled",
    });
    if (key === undefined) {
      console.error("Agav account sign-in cancelled.");
      return 1;
    }
  } else {
    key = (await readLineFromStdin()).trim();
  }

  if (!key) {
    console.error("No API key provided. Run `agav login` and paste your key, or pipe it on stdin.");
    return 1;
  }

  try {
    const identity = await signInWithApiKey(key, { accountService: parsed.accountService });
    const who = identity.email ? ` as ${identity.email}` : "";
    console.log(`Signed in to your Agav account${who}.`);
    return 0;
  } catch (error) {
    const detail = error instanceof AccountError || error instanceof Error ? error.message : String(error);
    console.error(`Agav account sign-in failed.\n${detail}`);
    return 1;
  }
}

/** Read a single line (up to the first newline / EOF) from stdin. */
function readLineFromStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      data += chunk;
      const nl = data.indexOf("\n");
      if (nl !== -1) {
        stdin.removeListener("data", onData);
        stdin.pause();
        resolve(data.slice(0, nl));
      }
    };
    const onEnd = (): void => resolve(data);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.resume();
  });
}
