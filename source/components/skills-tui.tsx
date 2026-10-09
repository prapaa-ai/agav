import React, { useMemo, useState } from "react";
import { ResourceManager } from "./resource-manager.js";
import { createResourceAdapter, createSkillsMarketplaceAdapter } from "../resources/adapters.js";

export interface SkillsTUIProps { onExit: () => void; marketplace?: boolean; }

export function SkillsTUI({ onExit, marketplace = true }: SkillsTUIProps) {
  const [mode, setMode] = useState(marketplace);
  const installed = useMemo(() => createResourceAdapter("skills"), []);
  const market = useMemo(() => createSkillsMarketplaceAdapter(), []);
  return <ResourceManager key={String(mode)} adapter={mode ? market : installed} onExit={onExit}
    actions={[
      { key: "Tab", label: mode ? "Installed" : "Marketplace", run: () => setMode(!mode) },
      ...(mode ? [{ key: "a", label: "Install", run: async (item: import("../resources/types.js").ResourceItem | undefined) => {
        if (!item) return;
        return installed.create!({ source: item.id, name: item.title });
      } }] : []),
    ]} />;
}
