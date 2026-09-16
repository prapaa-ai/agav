import { describe, expect, it } from "vitest";
import { isDestructiveCommand } from "../utils/sandbox.js";

describe("Cross-Platform Sandbox Destructive Command Guard", () => {
  describe("Windows CMD & Disk Formatting", () => {
    it("flags dangerous rmdir/rd commands with /s flag", () => {
      expect(isDestructiveCommand("rmdir /s /q C:\\Project")).toBe(true);
      expect(isDestructiveCommand("rd /s /q C:\\Project")).toBe(true);
      expect(isDestructiveCommand("rmdir /q /s temp")).toBe(true);
      expect(isDestructiveCommand("rmdir target /s")).toBe(true);
    });

    it("flags dangerous del/erase commands with /s flag", () => {
      expect(isDestructiveCommand("del /s /q *.log")).toBe(true);
      expect(isDestructiveCommand("del /f /s /q C:\\Data")).toBe(true);
      expect(isDestructiveCommand("erase /s /q C:\\Data")).toBe(true);
      expect(isDestructiveCommand("del dir /s")).toBe(true);
    });

    it("flags disk formatting and diskpart commands", () => {
      expect(isDestructiveCommand("format C: /fs:ntfs")).toBe(true);
      expect(isDestructiveCommand("FORMAT D:")).toBe(true);
      expect(isDestructiveCommand("diskpart /s wipe.txt")).toBe(true);
    });

    it("allows non-destructive Windows commands", () => {
      expect(isDestructiveCommand("del file.txt")).toBe(false);
      expect(isDestructiveCommand("rmdir empty_folder")).toBe(false);
      expect(isDestructiveCommand("rd single_dir")).toBe(false);
      expect(isDestructiveCommand("dir C:\\")).toBe(false);
    });
  });

  describe("PowerShell Destructive Operations", () => {
    it("flags Remove-Item with Recurse and Force", () => {
      expect(isDestructiveCommand("Remove-Item -Recurse -Force ./dist")).toBe(true);
      expect(isDestructiveCommand("Remove-Item -Force -Recurse ./build")).toBe(true);
      expect(isDestructiveCommand("Remove-Item -Path ./temp -Recurse -Force")).toBe(true);
      expect(isDestructiveCommand("ri -r -f ./node_modules")).toBe(true);
      expect(isDestructiveCommand("remove-item target -force -recurse")).toBe(true);
    });

    it("allows non-destructive PowerShell commands", () => {
      expect(isDestructiveCommand("Remove-Item file.txt")).toBe(false);
      expect(isDestructiveCommand("Remove-Item -Force file.txt")).toBe(false);
      expect(isDestructiveCommand("Get-ChildItem -Recurse")).toBe(false);
    });
  });

  describe("Destructive Git Operations", () => {
    it("flags destructive git resets, pushes, and cleans", () => {
      expect(isDestructiveCommand("git reset --hard HEAD~1")).toBe(true);
      expect(isDestructiveCommand("git push --force origin main")).toBe(true);
      expect(isDestructiveCommand("git push -f origin main")).toBe(true);
      expect(isDestructiveCommand("git clean -fdx")).toBe(true);
      expect(isDestructiveCommand("git clean -f")).toBe(true);
      expect(isDestructiveCommand("git branch -D old-branch")).toBe(true);
      expect(isDestructiveCommand("git branch -d merged-branch")).toBe(true);
    });

    it("flags git destructive worktree rollbacks", () => {
      expect(isDestructiveCommand("git checkout -- .")).toBe(true);
      expect(isDestructiveCommand("git restore .")).toBe(true);
      expect(isDestructiveCommand("git restore --staged .")).toBe(true);
    });

    it("allows safe git commands", () => {
      expect(isDestructiveCommand("git checkout feature/branch")).toBe(false);
      expect(isDestructiveCommand("git restore src/index.ts")).toBe(false);
      expect(isDestructiveCommand("git push origin main")).toBe(false);
      expect(isDestructiveCommand("git status")).toBe(false);
      expect(isDestructiveCommand("git branch -a")).toBe(false);
    });
  });

  describe("Destructive SQL & Database Commands", () => {
    it("flags SQL table and schema drop commands", () => {
      expect(isDestructiveCommand("DROP TABLE users;")).toBe(true);
      expect(isDestructiveCommand("drop table if exists orders")).toBe(true);
      expect(isDestructiveCommand("DROP SCHEMA public CASCADE;")).toBe(true);
      expect(isDestructiveCommand("TRUNCATE TABLE logs;")).toBe(true);
      expect(isDestructiveCommand("truncate sessions")).toBe(true);
    });

    it("flags broad unbounded delete commands", () => {
      expect(isDestructiveCommand("DELETE FROM audit_logs;")).toBe(true);
      expect(isDestructiveCommand("delete from users")).toBe(true);
      expect(isDestructiveCommand("DELETE FROM users WHERE 1=1;")).toBe(true);
    });

    it("allows targeted SQL queries", () => {
      expect(isDestructiveCommand("SELECT * FROM users WHERE 1=1;")).toBe(false);
      expect(isDestructiveCommand("DELETE FROM users WHERE id = 123;")).toBe(false);
      expect(isDestructiveCommand("UPDATE accounts SET balance = 0 WHERE id = 1;")).toBe(false);
    });
  });
});
