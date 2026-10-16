import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  STALE_ENTRY_MESSAGE,
  getSchedulerStatus,
  installScheduler,
  resolveSchedulerTarget,
  uninstallScheduler,
  type ExecFileFn,
  type SchedulerFs,
  type SchedulerTarget,
} from "../host/os-scheduler/index.js";
import {
  CRON_TAG,
  generateCronLine,
  generateSystemdService,
  generateSystemdTimer,
  parseCronLine,
  parseSystemdService,
  updateCrontab,
} from "../host/os-scheduler/linux.js";
import { generateLaunchdPlist, parseLaunchdPlist } from "../host/os-scheduler/macos.js";
import { generateTaskXml, parseTaskXml, splitWindowsArgs, quoteWindowsArg } from "../host/os-scheduler/windows.js";
import { runJobCli } from "../../cli/job-cli.js";
import { BACKGROUND_TICK_INTERNAL_FLAG } from "../packaging/manifest.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "os-scheduler");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8").replace(/\r\n/g, "\n");

const HOME = "/home/jane";
const TICK = BACKGROUND_TICK_INTERNAL_FLAG;
const NODE_TARGET: SchedulerTarget = {
  executable: "/usr/local/bin/node",
  args: ["/usr/local/lib/node_modules/agav/build/cli.js", TICK],
};

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function enoent(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
}

class MemFs implements SchedulerFs {
  files = new Map<string, string>();
  constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) this.files.set(k, v);
  }
  async readFile(p: string): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) throw enoent(p);
    return v;
  }
  async writeFile(p: string, data: string | Uint8Array): Promise<void> {
    this.files.set(p, typeof data === "string" ? data : Buffer.from(data).toString("latin1"));
  }
  async mkdir(): Promise<void> {}
  async rename(a: string, b: string): Promise<void> {
    const v = this.files.get(a);
    if (v === undefined) throw enoent(a);
    this.files.delete(a);
    this.files.set(b, v);
  }
  async unlink(p: string): Promise<void> {
    if (!this.files.delete(p)) throw enoent(p);
  }
  async access(p: string): Promise<void> {
    if (!this.files.has(p)) throw enoent(p);
  }
}

type Handler = (file: string, args: string[]) => { stdout?: string; error?: string } | undefined;

function fakeExec(handler: Handler = () => undefined) {
  const calls: string[] = [];
  const execFile: ExecFileFn = async (file, args) => {
    calls.push([file, ...args].join(" "));
    const r = handler(file, args) ?? {};
    if (r.error !== undefined) throw Object.assign(new Error(r.error), { stderr: r.error, code: 1 });
    return { stdout: r.stdout ?? "", stderr: "" };
  };
  return { calls, execFile };
}


// ---------------------------------------------------------------------------
// Golden files
// ---------------------------------------------------------------------------

describe("os-scheduler generators (golden files)", () => {
  it("systemd service", () => {
    expect(generateSystemdService(NODE_TARGET)).toBe(fixture("agav-job-tick.service"));
  });
  it("systemd timer", () => {
    expect(generateSystemdTimer()).toBe(fixture("agav-job-tick.timer"));
  });
  it("launchd plist (home dir normalised)", () => {
    const target = { executable: "/opt/homebrew/bin/agav", args: [TICK] };
    expect(generateLaunchdPlist(target, HOME)).toBe(fixture("dev.agav.job-tick.plist").replaceAll("{{HOME}}", HOME));
  });
  it("task scheduler XML (CRLF, quoted paths with spaces)", () => {
    const target = {
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\agav\\build\\cli.js", TICK],
    };
    const xml = generateTaskXml(target);
    expect(xml).toContain("\r\n");
    expect(xml.replace(/\r\n/g, "\n")).toBe(fixture("agav-job-tick.task.xml"));
    expect(parseTaskXml(xml)).toEqual(target);
  });
});

describe("os-scheduler quoting round-trips", () => {
  const tricky: SchedulerTarget = { executable: "/opt/My Apps/agav 100%", args: ["it's $HOME \"x\"", "job", "tick"] };
  it("systemd", () => {
    expect(parseSystemdService(generateSystemdService(tricky))).toEqual(tricky);
  });
  it("cron", () => {
    const line = generateCronLine(tricky);
    expect(line.endsWith(CRON_TAG)).toBe(true);
    expect(parseCronLine(line)).toEqual(tricky);
  });
  it("plist", () => {
    const t = { executable: "/a & <b>", args: ["job", "tick"] };
    expect(parseLaunchdPlist(generateLaunchdPlist(t, HOME))).toEqual(t);
  });
  it("windows args", () => {
    for (const s of ["C:\\a b\\", 'say "hi"', "plain", "", "trail\\\\"]) {
      expect(splitWindowsArgs(quoteWindowsArg(s))).toEqual([s]);
    }
  });
});

describe("updateCrontab", () => {
  it("adds, replaces idempotently, preserves other lines, removes", () => {
    const line = generateCronLine(NODE_TARGET);
    const base = "MAILTO=\"\"\n0 3 * * * /usr/bin/backup\n";
    const once = updateCrontab(base, line);
    expect(once).toBe(`${base}${line}\n`);
    expect(updateCrontab(once, line)).toBe(once);
    const replaced = updateCrontab(`${base}* * * * * /old/agav job tick ${CRON_TAG}\n`, line);
    expect(replaced).toBe(once);
    expect(updateCrontab(once, undefined)).toBe(base);
    expect(updateCrontab("", undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

describe("resolveSchedulerTarget (§8.4)", () => {
  it("standalone binary runs itself", async () => {
    expect(
      await resolveSchedulerTarget({ platform: "linux", standalone: true, execPath: "/usr/local/bin/agav", realpath: async (p) => p }),
    ).toEqual({ executable: "/usr/local/bin/agav", args: [TICK] });
  });
  it("node install uses execPath + resolved CLI entry", async () => {
    expect(
      await resolveSchedulerTarget({
        platform: "linux",
        standalone: false,
        execPath: "/usr/bin/node",
        entryPath: "/usr/lib/node_modules/.bin/agav",
        realpath: async (p) => (p === "/usr/lib/node_modules/.bin/agav" ? "/usr/lib/node_modules/agav/build/cli.js" : p),
      }),
    ).toEqual({ executable: "/usr/bin/node", args: ["/usr/lib/node_modules/agav/build/cli.js", TICK] });
  });
  it("prefers the Homebrew shim when realpath(which agav) is our Cellar executable", async () => {
    const cellar = "/opt/homebrew/Cellar/agav/1.2.3/bin/agav";
    const realpath = async (p: string) => (p === "/opt/homebrew/bin/agav" ? cellar : p);
    expect(
      await resolveSchedulerTarget({ platform: "darwin", standalone: true, execPath: cellar, which: async () => "/opt/homebrew/bin/agav", realpath }),
    ).toEqual({ executable: "/opt/homebrew/bin/agav", args: [TICK] });
    // A shim pointing at a different version is not used.
    expect(
      await resolveSchedulerTarget({
        platform: "darwin", standalone: true, execPath: cellar, which: async () => "/opt/homebrew/bin/agav",
        realpath: async (p) => (p === "/opt/homebrew/bin/agav" ? "/opt/homebrew/Cellar/agav/9.9.9/bin/agav" : p),
      }),
    ).toEqual({ executable: cellar, args: [TICK] });
  });
  it("prefers the Homebrew node shim for node installs under Cellar", async () => {
    const cellarNode = "/opt/homebrew/Cellar/node/22.1.0/bin/node";
    const target = await resolveSchedulerTarget({
      platform: "darwin", standalone: false, execPath: cellarNode, entryPath: "/opt/homebrew/lib/node_modules/agav/build/cli.js",
      which: async (n) => (n === "node" ? "/opt/homebrew/bin/node" : undefined),
      realpath: async (p) => (p === "/opt/homebrew/bin/node" ? cellarNode : p),
    });
    expect(target).toEqual({ executable: "/opt/homebrew/bin/node", args: ["/opt/homebrew/lib/node_modules/agav/build/cli.js", TICK] });
  });
});

// ---------------------------------------------------------------------------
// Installers (mocked execFile + in-memory fs)
// ---------------------------------------------------------------------------

const UNIT_DIR = `${HOME}/.config/systemd/user`;

describe("linux installer", () => {
  it("systemd: writes units then daemon-reload + enable --now; idempotent", async () => {
    const fs = new MemFs();
    const { calls, execFile } = fakeExec((file) => (file === "crontab" ? { error: "no crontab for jane" } : undefined));
    const deps = { platform: "linux" as const, homedir: HOME, uid: 1000, fs, execFile, target: NODE_TARGET };
    const r = await installScheduler(deps);
    expect(r.backend).toBe("systemd");
    expect(calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now agav-job-tick.timer",
      "crontab -l",
    ]);
    expect(fs.files.get(`${UNIT_DIR}/agav-job-tick.service`)).toBe(generateSystemdService(NODE_TARGET));
    expect(fs.files.get(`${UNIT_DIR}/agav-job-tick.timer`)).toBe(generateSystemdTimer());
    expect([...fs.files.keys()].some((k) => k.includes(".tmp-"))).toBe(false);
    const snapshot = new Map(fs.files);
    await installScheduler(deps);
    expect(fs.files).toEqual(snapshot);
  });

  it("falls back to crontab when systemctl --user is unavailable; idempotent and preserves lines", async () => {
    let crontab = "0 3 * * * /usr/bin/backup\n";
    const fs = new MemFs();
    const { calls, execFile } = fakeExec((file, args) => {
      if (file === "systemctl") return { error: "Failed to connect to bus" };
      if (file === "crontab" && args[0] === "-l") return { stdout: crontab };
      if (file === "crontab") {
        crontab = fs.files.get(args[0]!)!;
        return undefined;
      }
      return undefined;
    });
    const deps = { platform: "linux" as const, homedir: HOME, uid: 1000, fs, execFile, target: NODE_TARGET };
    expect((await installScheduler(deps)).backend).toBe("cron");
    expect(calls).toEqual([
      "systemctl --user show-environment",
      "crontab -l",
      `crontab ${HOME}/.agav/agav-job-tick.crontab.tmp`,
    ]);
    const expected = `0 3 * * * /usr/bin/backup\n${generateCronLine(NODE_TARGET)}\n`;
    expect(crontab).toBe(expected);
    expect(fs.files.has(`${HOME}/.agav/agav-job-tick.crontab.tmp`)).toBe(false);

    calls.length = 0;
    await installScheduler(deps);
    expect(calls).toEqual(["systemctl --user show-environment", "crontab -l"]); // unchanged → no rewrite
    expect(crontab).toBe(expected);

    // A stale tagged line from an older install is replaced, not duplicated.
    crontab = `0 3 * * * /usr/bin/backup\n* * * * * /old/agav job tick ${CRON_TAG}\n`;
    await installScheduler({ ...deps, target: NODE_TARGET });
    expect(crontab).toBe(expected);

    // Status via cron.
    fs.files.set(NODE_TARGET.executable, "");
    fs.files.set(NODE_TARGET.args[0]!, "");
    const s = await getSchedulerStatus(deps);
    expect(s).toMatchObject({ installed: true, backend: "cron", target: NODE_TARGET, targetExists: true, stale: false });

    calls.length = 0;
    expect(await uninstallScheduler(deps)).toEqual({ removed: true });
    expect(crontab).toBe("0 3 * * * /usr/bin/backup\n");
    expect(await getSchedulerStatus(deps)).toEqual({ installed: false });
  });

  it("uninstall disables the timer, removes units and reloads; leaves other files", async () => {
    const fs = new MemFs({
      [`${UNIT_DIR}/agav-job-tick.service`]: generateSystemdService(NODE_TARGET),
      [`${UNIT_DIR}/agav-job-tick.timer`]: generateSystemdTimer(),
      [`${HOME}/.agav/jobs/state.json`]: "{}",
    });
    const { calls, execFile } = fakeExec((file) => (file === "crontab" ? { error: "no crontab for jane" } : undefined));
    expect(await uninstallScheduler({ platform: "linux", homedir: HOME, fs, execFile })).toEqual({ removed: true });
    expect(calls).toEqual([
      "systemctl --user show-environment",
      "systemctl --user disable --now agav-job-tick.timer",
      "systemctl --user show-environment",
      "systemctl --user daemon-reload",
      "crontab -l",
    ]);
    expect([...fs.files.keys()]).toEqual([`${HOME}/.agav/jobs/state.json`]);
  });
});

describe("macOS installer", () => {
  const plistPath = `${HOME}/Library/LaunchAgents/dev.agav.job-tick.plist`;
  const target = { executable: "/opt/homebrew/bin/agav", args: [TICK] };

  it("fresh install: bootstrap only", async () => {
    const fs = new MemFs();
    const { calls, execFile } = fakeExec((_f, args) => (args[0] === "print" ? { error: "Could not find service" } : undefined));
    await installScheduler({ platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target });
    expect(calls).toEqual([
      "launchctl print gui/501/dev.agav.job-tick",
      `launchctl bootstrap gui/501 ${plistPath}`,
    ]);
    expect(fs.files.get(plistPath)).toBe(generateLaunchdPlist(target, HOME));
  });

  it("reinstall: bootout first when loaded", async () => {
    const fs = new MemFs();
    const { calls, execFile } = fakeExec();
    await installScheduler({ platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target });
    expect(calls).toEqual([
      "launchctl print gui/501/dev.agav.job-tick",
      "launchctl bootout gui/501/dev.agav.job-tick",
      `launchctl bootstrap gui/501 ${plistPath}`,
    ]);
  });

  it("uninstall boots out and removes the plist", async () => {
    const fs = new MemFs({ [plistPath]: generateLaunchdPlist(target, HOME) });
    const { calls, execFile } = fakeExec();
    expect(await uninstallScheduler({ platform: "darwin", homedir: HOME, uid: 501, fs, execFile })).toEqual({ removed: true });
    expect(calls).toEqual(["launchctl print gui/501/dev.agav.job-tick", "launchctl bootout gui/501/dev.agav.job-tick"]);
    expect(fs.files.has(plistPath)).toBe(false);
  });
});

describe("Windows installer", () => {
  const home = "C:\\Users\\Jane";
  const target = { executable: "C:\\Program Files\\Agav\\agav.exe", args: [TICK] };
  const xmlFile = `${home}\\.agav\\agav-job-tick.task.xml`;

  it("install creates the task from XML and cleans the temp file", async () => {
    const fs = new MemFs();
    let written: string | undefined;
    const { calls, execFile } = fakeExec((_f, args) => {
      if (args[0] === "/Create") written = fs.files.get(args[4]!);
      return undefined;
    });
    await installScheduler({ platform: "win32", homedir: home, fs, execFile, target });
    expect(calls).toEqual([`schtasks /Create /TN \\Agav\\JobTick /XML ${xmlFile} /F`]);
    expect(written).toBeDefined();
    expect(written!.startsWith("\xff\xfe")).toBe(true); // UTF-16LE BOM
    expect(fs.files.size).toBe(0);
  });

  it("uninstall deletes the task; missing task is not an error", async () => {
    const { calls, execFile } = fakeExec();
    expect(await uninstallScheduler({ platform: "win32", homedir: home, fs: new MemFs(), execFile })).toEqual({ removed: true });
    expect(calls).toEqual(["schtasks /Delete /TN \\Agav\\JobTick /F"]);
    const missing = fakeExec(() => ({ error: "ERROR: The system cannot find the file specified." }));
    expect(await uninstallScheduler({ platform: "win32", homedir: home, fs: new MemFs(), execFile: missing.execFile })).toEqual({ removed: false });
  });

  it("status queries the task XML", async () => {
    const fs = new MemFs({ [target.executable]: "" });
    const { calls, execFile } = fakeExec(() => ({ stdout: generateTaskXml(target) }));
    const s = await getSchedulerStatus({ platform: "win32", homedir: home, fs, execFile, target });
    expect(calls).toEqual(["schtasks /Query /TN \\Agav\\JobTick /XML"]);
    expect(s).toMatchObject({ installed: true, backend: "schtasks", target, targetExists: true, stale: false });
  });
});

describe("status stale detection", () => {
  const plistPath = `${HOME}/Library/LaunchAgents/dev.agav.job-tick.plist`;
  const old = { executable: "/opt/homebrew/Cellar/agav/1.0.0/bin/agav", args: [TICK] };
  const current = { executable: "/opt/homebrew/bin/agav", args: [TICK] };

  it("stale when target differs and is missing", async () => {
    const fs = new MemFs({ [plistPath]: generateLaunchdPlist(old, HOME) });
    const { execFile } = fakeExec();
    const s = await getSchedulerStatus({ platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target: current });
    expect(s).toMatchObject({ installed: true, target: old, targetExists: false, stale: true });
  });

  it("not stale when target differs but still exists", async () => {
    const fs = new MemFs({ [plistPath]: generateLaunchdPlist(old, HOME), [old.executable]: "" });
    const { execFile } = fakeExec();
    const s = await getSchedulerStatus({ platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target: current });
    expect(s).toMatchObject({ targetExists: true, stale: false });
  });

  it("node installs also require the CLI entry to exist", async () => {
    const fs = new MemFs({
      [`${UNIT_DIR}/agav-job-tick.service`]: generateSystemdService(NODE_TARGET),
      [`${UNIT_DIR}/agav-job-tick.timer`]: generateSystemdTimer(),
      [NODE_TARGET.executable]: "",
    });
    const { execFile } = fakeExec();
    const s = await getSchedulerStatus({
      platform: "linux", homedir: HOME, fs, execFile,
      target: { executable: "/usr/bin/node", args: ["/new/cli.js", TICK] },
    });
    expect(s).toMatchObject({ installed: true, backend: "systemd", targetExists: false, stale: true });
  });

  describe("legacy `job tick` entries are recognised but reported outdated", () => {
    const legacyNode = { executable: NODE_TARGET.executable, args: [NODE_TARGET.args[0]!, "job", "tick"] };
    const legacyBin = { executable: "/opt/homebrew/bin/agav", args: ["job", "tick"] };

    it("systemd ExecStart", async () => {
      const fs = new MemFs({
        [`${UNIT_DIR}/agav-job-tick.service`]: generateSystemdService(legacyNode),
        [`${UNIT_DIR}/agav-job-tick.timer`]: generateSystemdTimer(),
        [legacyNode.executable]: "",
        [legacyNode.args[0]!]: "",
      });
      const { execFile } = fakeExec();
      const s = await getSchedulerStatus({ platform: "linux", homedir: HOME, fs, execFile, target: NODE_TARGET });
      expect(s).toMatchObject({ installed: true, backend: "systemd", target: legacyNode, targetExists: true, outdated: true, stale: true });
    });

    it("crontab tag line", async () => {
      const line = `* * * * * /usr/local/bin/node /usr/local/lib/node_modules/agav/build/cli.js job tick >/dev/null 2>&1 ${CRON_TAG}`;
      const fs = new MemFs({ [legacyNode.executable]: "", [legacyNode.args[0]!]: "" });
      const { execFile } = fakeExec((file, args) => {
        if (file === "systemctl") return { error: "no bus" };
        if (file === "crontab" && args[0] === "-l") return { stdout: `${line}\n` };
        return undefined;
      });
      const s = await getSchedulerStatus({ platform: "linux", homedir: HOME, fs, execFile, target: NODE_TARGET });
      expect(s).toMatchObject({ installed: true, backend: "cron", target: legacyNode, targetExists: true, outdated: true, stale: true });
    });

    it("plist ProgramArguments", async () => {
      const plistPath = `${HOME}/Library/LaunchAgents/dev.agav.job-tick.plist`;
      const fs = new MemFs({ [plistPath]: generateLaunchdPlist(legacyBin, HOME), [legacyBin.executable]: "" });
      const { execFile } = fakeExec();
      const s = await getSchedulerStatus({
        platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target: { executable: legacyBin.executable, args: [TICK] },
      });
      expect(s).toMatchObject({ installed: true, target: legacyBin, targetExists: true, outdated: true, stale: true });
    });

    it("task XML", async () => {
      const exe = "C:\\Program Files\\Agav\\agav.exe";
      const legacy = { executable: exe, args: ["job", "tick"] };
      const fs = new MemFs({ [exe]: "" });
      const { execFile } = fakeExec(() => ({ stdout: generateTaskXml(legacy) }));
      const s = await getSchedulerStatus({ platform: "win32", homedir: "C:\\Users\\Jane", fs, execFile, target: { executable: exe, args: [TICK] } });
      expect(s).toMatchObject({ installed: true, backend: "schtasks", target: legacy, targetExists: true, outdated: true, stale: true });
    });

    it("current-form entries are not outdated", async () => {
      const plistPath = `${HOME}/Library/LaunchAgents/dev.agav.job-tick.plist`;
      const t = { executable: "/opt/homebrew/bin/agav", args: [TICK] };
      const fs = new MemFs({ [plistPath]: generateLaunchdPlist(t, HOME), [t.executable]: "" });
      const { execFile } = fakeExec();
      const s = await getSchedulerStatus({ platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target: t });
      expect(s).toMatchObject({ outdated: false, stale: false });
    });
  });
});

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

describe("agav job tick --install/--uninstall/--status", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (s: string) => { out.push(s); }, stderr: (s: string) => { err.push(s); } };
  }
  const plistPath = `${HOME}/Library/LaunchAgents/dev.agav.job-tick.plist`;
  const target = { executable: "/opt/homebrew/bin/agav", args: [TICK] };

  it("install → status (0) → uninstall → status (3)", async () => {
    const fs = new MemFs({ [target.executable]: "" });
    let loaded = false;
    const { execFile } = fakeExec((_f, args) => {
      if (args[0] === "print") return loaded ? undefined : { error: "not found" };
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return undefined;
    });
    const osScheduler = { platform: "darwin" as const, homedir: HOME, uid: 501, fs, execFile, target };
    const a = io();
    expect(await runJobCli(["tick", "--install"], { ...a, osScheduler })).toBe(0);
    expect(a.out.join("")).toContain(`installed (launchd): /opt/homebrew/bin/agav ${TICK}`);
    expect(fs.files.has(plistPath)).toBe(true);

    const b = io();
    expect(await runJobCli(["tick", "--status"], { ...b, osScheduler })).toBe(0);
    expect(b.out.join("")).toContain("installed (launchd");
    expect(b.out.join("")).toContain(`command: /opt/homebrew/bin/agav ${TICK}`);
    expect(b.out.join("")).toContain("target executable: exists");
    expect(b.err.join("")).toBe("");

    const c = io();
    expect(await runJobCli(["tick", "--uninstall"], { ...c, osScheduler })).toBe(0);
    expect(c.out.join("")).toContain("removed");

    const d = io();
    expect(await runJobCli(["tick", "--status"], { ...d, osScheduler })).toBe(3);
    expect(d.out.join("")).toContain("not installed");
  });

  it("status warns when the entry is stale", async () => {
    const old = { executable: "/gone/agav", args: [TICK] };
    const fs = new MemFs({ [plistPath]: generateLaunchdPlist(old, HOME) });
    const { execFile } = fakeExec();
    const a = io();
    expect(await runJobCli(["tick", "--status"], { ...a, osScheduler: { platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target } })).toBe(0);
    expect(a.out.join("")).toContain("target executable: missing");
    expect(a.err.join("")).toContain(STALE_ENTRY_MESSAGE);
  });

  it("status reports a legacy `job tick` entry as installed but asks to re-install", async () => {
    const legacy = { executable: target.executable, args: ["job", "tick"] };
    const fs = new MemFs({ [plistPath]: generateLaunchdPlist(legacy, HOME), [target.executable]: "" });
    const { execFile } = fakeExec();
    const a = io();
    expect(await runJobCli(["tick", "--status"], { ...a, osScheduler: { platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target } })).toBe(0);
    expect(a.out.join("")).toContain("installed (launchd");
    expect(a.out.join("")).toContain("command: /opt/homebrew/bin/agav job tick");
    expect(a.out.join("")).toContain("target executable: exists");
    expect(a.err.join("")).toContain(STALE_ENTRY_MESSAGE);
    expect(STALE_ENTRY_MESSAGE).toMatch(/outdated.*re-run .*--install/);
  });

  it("returns 1 on installer failure and on conflicting flags", async () => {
    const { execFile } = fakeExec(() => ({ error: "Access is denied." }));
    const a = io();
    expect(await runJobCli(["tick", "--install"], { ...a, osScheduler: { platform: "win32", homedir: "C:\\U", fs: new MemFs(), execFile, target } })).toBe(1);
    expect(a.err.join("")).toContain("Access is denied.");
    const b = io();
    expect(await runJobCli(["tick", "--install", "--uninstall"], { ...b })).toBe(1);
    expect(b.err.join("")).toContain("cannot be combined");
  });

  it("does not run a tick when a scheduler flag is given", async () => {
    let ticked = false;
    const fs = new MemFs();
    const { execFile } = fakeExec(() => ({ error: "not found" }));
    const a = io();
    await runJobCli(["tick", "--status"], {
      ...a,
      loadConfig: async () => { ticked = true; return {}; },
      osScheduler: { platform: "darwin", homedir: HOME, uid: 501, fs, execFile, target },
    });
    expect(ticked).toBe(false);
  });
});
