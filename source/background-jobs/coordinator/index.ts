/**
 * T14 — Coordinator barrel export.
 *
 * Consumers outside this subsystem (T16 tools/commands, T15 schedule
 * engine) should import `createCoordinator` from here rather than reaching
 * into `./service.js` directly, so this remains the single, stable surface
 * for the coordinator module.
 */
export { createCoordinator } from "./service.js";
export type { Coordinator, CoordinatorExtensions, CreateCoordinatorOptions } from "./service.js";
export { reserveCapacity } from "./admission.js";
export type { ReserveCapacityResult } from "./admission.js";
export { launchSupervisorForJob, socketNameForJob } from "./launcher.js";
export type { LaunchSupervisorForJobArgs } from "./launcher.js";

// Re-exported for convenience so T16/T15 can `import type { CoordinatorClient } from
// "../coordinator/index.js"` without a second import from `../types.js`.
export type { CoordinatorClient } from "../types.js";
