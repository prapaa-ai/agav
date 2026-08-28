import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

import { checkPathBoundary } from "../utils/path-guard.js";

const home = homedir();
const tmp = tmpdir();

describe("utils/path-guard", () => {
  describe("read mode", () => {
    it("allows normal file paths", async () => {
      expect(await checkPathBoundary("/some/project/file.ts", "read")).toBeNull();
      expect(await checkPathBoundary(resolve(home, "Documents/readme.md"), "read")).toBeNull();
      expect(await checkPathBoundary("relative/path.txt", "read")).toBeNull();
    });

    it("blocks ~/.ssh", async () => {
      const sshDir = resolve(home, ".ssh");
      expect(await checkPathBoundary(sshDir, "read")).toContain("protected credential path");
      expect(await checkPathBoundary(resolve(sshDir, "id_rsa"), "read")).toContain("protected credential path");
    });

    it("blocks ~/.aws", async () => {
      const awsDir = resolve(home, ".aws");
      expect(await checkPathBoundary(awsDir, "read")).toContain("protected credential path");
      expect(await checkPathBoundary(resolve(awsDir, "credentials"), "read")).toContain("protected credential path");
    });

    it("blocks ~/.gnupg", async () => {
      const gpgDir = resolve(home, ".gnupg");
      expect(await checkPathBoundary(gpgDir, "read")).toContain("protected credential path");
      expect(await checkPathBoundary(resolve(gpgDir, "secring.gpg"), "read")).toContain("protected credential path");
    });

    it("blocks ~/.kube/config", async () => {
      const kubeConfig = resolve(home, ".kube", "config");
      expect(await checkPathBoundary(kubeConfig, "read")).toContain("protected credential path");
    });
  });

  describe("write mode", () => {
    it("allows files inside CWD", async () => {
      const cwd = process.cwd();
      expect(await checkPathBoundary(resolve(cwd, "file.ts"), "write")).toBeNull();
      expect(await checkPathBoundary(resolve(cwd, "src/deep/nested.ts"), "write")).toBeNull();
    });

    it("allows files inside temp directory", async () => {
      expect(await checkPathBoundary(resolve(tmp, "agav-tmp-file"), "write")).toBeNull();
      expect(await checkPathBoundary(resolve(tmp, "sub/dir/file.txt"), "write")).toBeNull();
    });

    it("allows files inside ~/.agav", async () => {
      const agavDir = resolve(home, ".agav");
      expect(await checkPathBoundary(resolve(agavDir, "config.json"), "write")).toBeNull();
      expect(await checkPathBoundary(resolve(agavDir, "data/store.db"), "write")).toBeNull();
    });

    it("blocks files outside CWD (e.g. /etc/passwd, ~/Desktop/file.txt)", async () => {
      expect(await checkPathBoundary("/etc/passwd", "write")).toContain("Write denied");
      expect(await checkPathBoundary(resolve(home, "Desktop/file.txt"), "write")).toContain("Write denied");
      expect(await checkPathBoundary("/usr/local/bin/something", "write")).toContain("Write denied");
    });

    it("blocks ~/.ssh, ~/.aws, ~/.gnupg", async () => {
      expect(await checkPathBoundary(resolve(home, ".ssh/authorized_keys"), "write")).toContain("protected credential path");
      expect(await checkPathBoundary(resolve(home, ".aws/config"), "write")).toContain("protected credential path");
      expect(await checkPathBoundary(resolve(home, ".gnupg/trustdb.gpg"), "write")).toContain("protected credential path");
    });

    it("blocks .git directory inside CWD", async () => {
      const cwd = process.cwd();
      const gitDir = resolve(cwd, ".git");
      expect(await checkPathBoundary(gitDir, "write")).toContain("protected directory");
      expect(await checkPathBoundary(resolve(gitDir, "config"), "write")).toContain("protected directory");
      expect(await checkPathBoundary(resolve(gitDir, "refs/heads/main"), "write")).toContain("protected directory");
    });

    it("blocks .agav directory inside CWD (project-local config)", async () => {
      const cwd = process.cwd();
      const agavLocal = resolve(cwd, ".agav");
      expect(await checkPathBoundary(agavLocal, "write")).toContain("protected directory");
      expect(await checkPathBoundary(resolve(agavLocal, "config.yaml"), "write")).toContain("protected directory");
    });
  });

  describe("edge cases", () => {
    it("exact path match on denied credential directories", async () => {
      expect(await checkPathBoundary(resolve(home, ".ssh"), "read")).not.toBeNull();
      expect(await checkPathBoundary(resolve(home, ".ssh"), "write")).not.toBeNull();
    });

    it("exact CWD path is allowed for write", async () => {
      expect(await checkPathBoundary(process.cwd(), "write")).toBeNull();
    });

    it("nested paths inside denied directories are blocked", async () => {
      expect(await checkPathBoundary(resolve(home, ".ssh/keys/backup/id_rsa"), "read")).toContain("protected credential path");
      expect(await checkPathBoundary(resolve(home, ".aws/sso/cache/token.json"), "write")).toContain("protected credential path");
    });

    it("paths with similar prefix but not inside denied dir are allowed", async () => {
      // ~/.sshx should NOT be blocked — it's not ~/.ssh
      expect(await checkPathBoundary(resolve(home, ".sshx/file"), "read")).toBeNull();
      expect(await checkPathBoundary(resolve(home, ".awsome/file"), "read")).toBeNull();
    });
  });
});
