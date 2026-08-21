import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encrypt, decrypt } from "../utils/encrypt.js";
import {
  loadAgentConfig,
  saveAgentConfig,
  hasRequiredCredentials,
  getMissingCredentials,
} from "../agents/credentials.js";
import type { AgentManifest } from "../agents/types.js";

describe("agents/credentials", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agav-cred-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("encrypt/decrypt round-trip", () => {
    it("encrypts and decrypts a value", () => {
      const original = "my-secret-api-key-12345";
      const encrypted = encrypt(original);
      expect(encrypted).not.toBe(original);
      expect(encrypted.startsWith("enc:")).toBe(true);
      expect(decrypt(encrypted)).toBe(original);
    });

    it("handles empty string", () => {
      expect(encrypt("")).toBe("");
      expect(decrypt("")).toBe("");
    });
  });

  describe("saveAgentConfig / loadAgentConfig round-trip", () => {
    it("saves encrypted and loads decrypted", async () => {
      const config = { API_KEY: "secret-123", API_SECRET: "secret-456" };
      await saveAgentConfig(dir, config);

      // Verify file is encrypted on disk
      const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf-8"));
      expect(raw.API_KEY).not.toBe("secret-123");
      expect(raw.API_KEY.startsWith("enc:")).toBe(true);

      // Load should decrypt
      const loaded = await loadAgentConfig(dir);
      expect(loaded).toEqual(config);
    });

    it("returns empty object for missing config.json", async () => {
      const loaded = await loadAgentConfig(join(dir, "nonexistent"));
      expect(loaded).toEqual({});
    });
  });

  describe("file permissions", () => {
    it("creates config.json with restricted permissions", async () => {
      await saveAgentConfig(dir, { KEY: "value" });
      const stats = await fsStat(join(dir, "config.json"));
      // On Windows, mode bits are limited; on Unix, check 0o600
      if (process.platform !== "win32") {
        const mode = stats.mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });
  });

  describe("hasRequiredCredentials and getMissingCredentials agreement", () => {
    const manifest = {
      name: "test",
      description: "test",
      version: "1.0.0",
      "required-config": ["API_KEY", "API_SECRET"],
    } as AgentManifest;

    it("both report missing when nothing is configured", async () => {
      const has = await hasRequiredCredentials(dir, manifest);
      const missing = await getMissingCredentials(dir, manifest);
      expect(has).toBe(false);
      expect(missing).toEqual(["API_KEY", "API_SECRET"]);
    });

    it("both agree when config.json has all keys", async () => {
      await saveAgentConfig(dir, { API_KEY: "k1", API_SECRET: "k2" });
      const has = await hasRequiredCredentials(dir, manifest);
      const missing = await getMissingCredentials(dir, manifest);
      expect(has).toBe(true);
      expect(missing).toEqual([]);
    });

    it("both agree when env vars provide missing keys", async () => {
      const oldKey = process.env.API_KEY;
      const oldSecret = process.env.API_SECRET;
      try {
        process.env.API_KEY = "from-env";
        process.env.API_SECRET = "from-env";
        const has = await hasRequiredCredentials(dir, manifest);
        const missing = await getMissingCredentials(dir, manifest);
        expect(has).toBe(true);
        expect(missing).toEqual([]);
      } finally {
        if (oldKey === undefined) delete process.env.API_KEY;
        else process.env.API_KEY = oldKey;
        if (oldSecret === undefined) delete process.env.API_SECRET;
        else process.env.API_SECRET = oldSecret;
      }
    });
  });
});
