/**
 * Platform adapter selector — owned by T01 (integration lead).
 *
 * T02/T03/T04 each implement and export a `platformAdapter: PlatformAdapter`
 * from their own file (`linux.ts`, `macos.ts`, `windows.ts`) and MUST NOT
 * edit this selector. This indirection keeps `platform/*` files mutually
 * independent (no agent needs to touch another OS's file to get picked up).
 */
import { platform as osPlatform } from "node:os";
import type { PlatformAdapter } from "../types.js";
import { BackgroundJobError } from "../types.js";

let cached: PlatformAdapter | null = null;

export async function getPlatformAdapter(): Promise<PlatformAdapter> {
  if (cached) return cached;
  const p = osPlatform();
  let adapter: PlatformAdapter;
  if (p === "linux") {
    adapter = (await import("./linux.js")).platformAdapter;
  } else if (p === "darwin") {
    adapter = (await import("./macos.js")).platformAdapter;
  } else if (p === "win32") {
    adapter = (await import("./windows.js")).platformAdapter;
  } else {
    throw new BackgroundJobError("unsupported-platform", `Background jobs are not supported on platform "${p}".`);
  }
  cached = adapter;
  return adapter;
}

/** Test-only override so unit tests can inject a fake adapter without mocking node:os. */
export function __setPlatformAdapterForTests(adapter: PlatformAdapter | null): void {
  cached = adapter;
}
