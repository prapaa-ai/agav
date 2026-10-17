import type { PlatformAdapter, ProcessIdentity } from "../types.js";

/**
 * PID existence alone never proves identity (PIDs are recycled); recovery code must go through
 * `verifyAlive`, which compares the PID with its creation identity.
 */
export async function isSameLiveProcess(identity: ProcessIdentity, platformAdapter: PlatformAdapter): Promise<boolean> {
  return platformAdapter.verifyAlive(identity);
}
