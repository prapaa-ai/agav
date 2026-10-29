import { signInWithApiKey, signOutAccount, parseConsumerArgs } from "../account/account-login.js";
import { readSecretFromTty } from "../account/secret-prompt.js";
import { AccountError } from "../account/types.js";

/**
 * `agav login --key` / `agav logout --account` — consumer Agav account sign-in
 * from the CLI. Mirrors the `/login` slash command's consumer path. Returns a
 * process exit code.
 *
 * Key input precedence (never echoed, never in shell history unless the user
 * forces it):
 *   1. `--key=<value>` / `--key <value>`  — explicit, with a shell-history warning
 *   2. a TTY                              — masked interactive prompt
 *   3. no TTY                             — read one line from stdin (for `… | agav login --key`)
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

  // Resolve the key: explicit flag (warn), else masked TTY prompt, else stdin.
  let key: string | undefined = parsed.inlineKey?.trim() || undefined;
  if (key) {
    console.error(
      "Warning: passing --key on the command line can leave your key in shell history. " +
      "Prefer `agav login --key` with no value and paste it when prompted.",
    );
  } else if (process.stdin.isTTY) {
    key = await readSecretFromTty({
      label: "Paste your Agav API key (from https://agav.dev/account), then Enter: ",
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
    console.error("No API key provided. Usage: agav login --key  (you'll be prompted to paste it)");
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
