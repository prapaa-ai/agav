import { getSessionConfigOverridePaths, setSessionConfigOverrides, type AgavConfig } from "../config/config.js";
import { applyConfigOverrides, isSessionConfigOverrideKey, type ConfigOverride } from "../config/cli-overrides.js";
import type { SessionRuntimeRecord } from "./store.js";

/** Private launch environment only: never put this payload in argv or durable metadata. */
export const SESSION_CONFIG_OVERRIDES_ENV = "AGAV_SESSION_CONFIG_OVERRIDES";

export function sessionConfigOverrideEnvironment(config: AgavConfig, record: Pick<SessionRuntimeRecord, "id" | "generation">): Record<string, string> {
	const keys = [...new Set(getSessionConfigOverridePaths().map(path => path[0]!))];
	if (!keys.length) return {};
	// Capture effective values, not the original CLI values: dedicated flags and
	// runtime changes must win. Whole keys also preserve indexed/nested edits.
	const entries = keys.map(key => ({ path: [key], value: config[key as keyof AgavConfig] }));
	return { [SESSION_CONFIG_OVERRIDES_ENV]: JSON.stringify({ id: record.id, generation: record.generation, entries }) };
}

/** Consume before config loading; tools/subprocesses must not inherit the secret payload. */
export function restoreSessionConfigOverrides(record: Pick<SessionRuntimeRecord, "id" | "generation">): void {
	const raw = process.env[SESSION_CONFIG_OVERRIDES_ENV];
	delete process.env[SESSION_CONFIG_OVERRIDES_ENV];
	if (raw === undefined) return;
	let entries: ConfigOverride[];
	try {
		const payload = JSON.parse(raw);
		if (!payload || payload.id !== record.id || payload.generation !== record.generation || !Array.isArray(payload.entries)) throw new Error();
		for (const entry of payload.entries) {
			if (!entry || !Array.isArray(entry.path) || entry.path.length !== 1 || typeof entry.path[0] !== "string"
				|| !isSessionConfigOverrideKey(entry.path[0])) throw new Error();
		}
		entries = payload.entries;
	} catch {
		// JSON parser messages can contain credentials: never include the input/cause.
		throw new Error("Invalid session config overrides; refusing to start worker.");
	}
	setSessionConfigOverrides({ entries, apply: config => applyConfigOverrides(config, structuredClone(entries)) });
}
