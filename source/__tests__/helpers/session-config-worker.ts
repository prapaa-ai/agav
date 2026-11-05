import { loadConfig } from "../../config/config.js";
import { restoreSessionConfigOverrides, SESSION_CONFIG_OVERRIDES_ENV } from "../../sessions/config-overrides.js";

const [id, generation] = process.argv.slice(2);
if (!id || !generation) throw new Error("Missing fixture identity");
restoreSessionConfigOverrides({ id, generation });
const config = await loadConfig();
// Report comparisons only, never the private credential itself.
process.stdout.write(JSON.stringify({
	credentialMatches: config.anthropicApiKey === "session-account",
	backgroundJobsEnabled: config.backgroundJobsEnabled,
	errorRetries: config.errorRetries,
	channelConsumed: process.env[SESSION_CONFIG_OVERRIDES_ENV] === undefined,
}));
