import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

import { checkPathBoundary } from "../utils/path-guard.js";

const home = homedir();
const tmp = tmpdir();

describe("utils/path-guard", () => {
  describe("read mode", () => {
    it("allows normal file paths", () => {
      expect(checkPathBoundary("/some/project/file.ts", "read")).toBeNull();
      expect(checkPathBoundary(resolve(home, "Documents/readme.md"), "read")).toBeNull();
      expect(checkPathBoundary("relative/path.txt", "read")).toBeNull();
    });

    it("blocks ~/.ssh", () => {
      const sshDir = resolve(home, ".ssh");
      expect(checkPathBoundary(sshDir, "read")).toContain("protected credential path");
      expect(checkPathBoundary(resolve(sshDir, "id_rsa"), "read")).toContain("protected credential path");
    });

    it("blocks ~/.aws", () => {
      const awsDir = resolve(home, ".aws");
      expect(checkPathBoundary(awsDir, "read")).toContain("protected credential path");
      expect(checkPathBoundary(resolve(awsDir, "credentials"), "read")).toContain("protected credential path");
    });

    it("blocks ~/.gnupg", () => {
      const gpgDir = resolve(home, ".gnupg");
      expect(checkPathBoundary(gpgDir, "read")).toContain("protected credential path");
      expect(checkPathBoundary(resolve(gpgDir, "secring.gpg"), "read")).toContain("protected credential path");
    });

    it("blocks ~/.kube/config", () => {
      const kubeConfig = resolve(home, ".kube", "config");
      expect(checkPathBoundary(kubeConfig, "read")).toContain("protected credential path");
    });
  });

  describe("write mode", () => {
    it("allows files inside CWD", () => {
      const cwd = process.cwd();
      expect(checkPathBoundary(resolve(cwd, "file.ts"), "write")).toBeNull();
      expect(checkPathBoundary(resolve(cwd, "src/deep/nested.ts"), "write")).toBeNull();
    });

    it("allows files inside temp directory", () => {
      expect(checkPathBoundary(resolve(tmp, "agav-tmp-file"), "write")).toBeNull();
      expect(checkPathBoundary(resolve(tmp, "sub/dir/file.txt"), "write")).toBeNull();
    });

    it("allows files inside ~/.agav", () => {
      const agavDir = resolve(home, ".agav");
      expect(checkPathBoundary(resolve(agavDir, "config.json"), "write")).toBeNull();
      expect(checkPathBoundary(resolve(agavDir, "data/store.db"), "write")).toBeNull();
    });

    it("blocks files outside CWD (e.g. /etc/passwd, ~/Desktop/file.txt)", () => {
      expect(checkPathBoundary("/etc/passwd", "write")).toContain("Write denied");
      expect(checkPathBoundary(resolve(home, "Desktop/file.txt"), "write")).toContain("Write denied");
      expect(checkPathBoundary("/usr/local/bin/something", "write")).toContain("Write denied");
    });

    it("blocks ~/.ssh, ~/.aws, ~/.gnupg", () => {
      expect(checkPathBoundary(resolve(home, ".ssh/authorized_keys"), "write")).toContain("protected credential path");
      expect(checkPathBoundary(resolve(home, ".aws/config"), "write")).toContain("protected credential path");
      expect(checkPathBoundary(resolve(home, ".gnupg/trustdb.gpg"), "write")).toContain("protected credential path");
    });

    it("blocks .git directory inside CWD", () => {
      const cwd = process.cwd();
      const gitDir = resolve(cwd, ".git");
      expect(checkPathBoundary(gitDir, "write")).toContain("protected directory");
      expect(checkPathBoundary(resolve(gitDir, "config"), "write")).toContain("protected directory");
      expect(checkPathBoundary(resolve(gitDir, "refs/heads/main"), "write")).toContain("protected directory");
    });

    it("blocks .agav directory inside CWD (project-local config)", () => {
      const cwd = process.cwd();
      const agavLocal = resolve(cwd, ".agav");
      expect(checkPathBoundary(agavLocal, "write")).toContain("protected directory");
      expect(checkPathBoundary(resolve(agavLocal, "config.yaml"), "write")).toContain("protected directory");
    });
  });

  describe("edge cases", () => {
    it("exact path match on denied credential directories", () => {
      expect(checkPathBoundary(resolve(home, ".ssh"), "read")).not.toBeNull();
      expect(checkPathBoundary(resolve(home, ".ssh"), "write")).not.toBeNull();
    });

    it("exact CWD path is allowed for write", () => {
      expect(checkPathBoundary(process.cwd(), "write")).toBeNull();
    });

    it("nested paths inside denied directories are blocked", () => {
      expect(checkPathBoundary(resolve(home, ".ssh/keys/backup/id_rsa"), "read")).toContain("protected credential path");
      expect(checkPathBoundary(resolve(home, ".aws/sso/cache/token.json"), "write")).toContain("protected credential path");
    });

    it("paths with similar prefix but not inside denied dir are allowed", () => {
      // ~/.sshx should NOT be blocked — it's not ~/.ssh
      expect(checkPathBoundary(resolve(home, ".sshx/file"), "read")).toBeNull();
      expect(checkPathBoundary(resolve(home, ".awsome/file"), "read")).toBeNull();
    });
  });
});
