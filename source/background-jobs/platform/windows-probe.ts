export async function readProcessStartTimeWindows(pid: number): Promise<string | undefined> {
  try {
    const { spawn } = await import("node:child_process");
    const psCommand = `
      $proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
      if ($proc) {
        $startTime = $proc.StartTime
        if ($startTime -ne $null) {
          $startTime.ToString("o")
        }
      }
    `;
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn("powershell", ["-NoProfile", "-Command", psCommand], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else resolve("");
      });
    });
    if (!result) return undefined;
    const iso = new Date(result).toISOString();
    return isNaN(new Date(iso).getTime()) ? undefined : iso;
  } catch {
    return undefined;
  }
}