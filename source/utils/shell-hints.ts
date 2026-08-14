type Shell = "posix" | "powershell" | "cmd";

function detectShell(): Shell {
  if (process.platform !== "win32") return "posix";
  // Git Bash, MSYS2, and Cygwin report win32 but want POSIX syntax. MSYSTEM is
  // exported by the Git Bash launcher; SHELL is set by MSYS and Cygwin and by
  // neither cmd nor PowerShell. Without this they fall through to the
  // PSModulePath check below and get told to use PowerShell syntax.
  if (process.env.MSYSTEM || /[\\/](ba|z|k)?sh(\.exe)?$/.test(process.env.SHELL ?? "")) {
    return "posix";
  }
  // cmd.exe often inherits PSModulePath, so that variable alone is not enough
  // to identify a PowerShell host. PROMPT is cmd-specific and lets us avoid
  // showing PowerShell syntax when users launch Agav from cmd.
  if (process.env.PROMPT) return "cmd";
  return process.env.PSModulePath ? "powershell" : "cmd";
}

export function setEnvHint(name: string, value: string): string {
  switch (detectShell()) {
    case "powershell":
      return `$env:${name}="${value}"`;
    case "cmd":
      return `set ${name}=${value}`;
    default:
      return `export ${name}="${value}"`;
  }
}

export function agavHomePath(relativePath = ""): string {
  const normalizedPath = relativePath.replace(/^\/+/, "");
  switch (detectShell()) {
    case "powershell":
      return `$HOME\\.agav\\${normalizedPath.replaceAll("/", "\\")}`;
    case "cmd":
      return `%USERPROFILE%\\.agav\\${normalizedPath.replaceAll("/", "\\")}`;
    default:
      return `~/.agav/${normalizedPath}`;
  }
}

export function reinstallHint(): string {
  switch (detectShell()) {
    case "powershell":
      return "irm https://agav.dev/install.ps1 | iex";
    case "cmd":
      return "curl -fsSL https://agav.dev/install.cmd -o install.cmd && install.cmd";
    default:
      return "curl -fsSL https://agav.dev/install.sh | bash";
  }
}
