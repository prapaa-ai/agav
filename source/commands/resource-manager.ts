import type { CommandContext, CommandResult } from "./types.js";
import type { ResourceKind } from "../resources/types.js";

/** Only the interactive app supplies this hook; scripts retain the text API. */
export function openResourceManager(kind: ResourceKind, context: CommandContext, marketplace = false): Promise<CommandResult> | undefined {
  if (!context.showResourceTUI || context.isLoading) return undefined;
  context.setPickerActive(true);
  return new Promise<CommandResult>((resolve, reject) => {
    try {
      context.showResourceTUI!(kind, () => {
        context.setPickerActive(false);
        resolve({ type: "none" });
      }, marketplace);
    } catch (error) {
      context.setPickerActive(false);
      reject(error);
    }
  });
}
