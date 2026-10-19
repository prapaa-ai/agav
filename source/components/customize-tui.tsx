import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "../ink/index.js";
import { getTheme } from "../config/theme.js";
import { buildStatusBarText, type StatusBarSegments } from "./status-bar.js";
import {
  defaultStatusBarLayout,
  isDefaultStatusBarLayout,
  isStatusBarItemEnabled,
  normalizeStatusBarLayout,
  statusBarItemMeta,
  type StatusBarLayout,
} from "../config/status-bar-layout.js";

export interface CustomizeTUIProps {
  /** The current persisted footer layout (normalized on entry). */
  initialLayout?: StatusBarLayout;
  /** Formatted footer segment text for a faithful live preview. */
  preview: StatusBarSegments;
  /** Called on every edit so the real footer updates live. */
  onChange: (layout: StatusBarLayout) => void;
  /** Called when the user closes the customization UI, with the final layout. */
  onExit: (layout: StatusBarLayout) => void;
}

/** Which screen of the customization flow is showing. */
type Screen = "hub" | "statusBar";

/** Customization areas listed on the hub. Add entries here as new areas ship. */
const AREAS: { id: Screen; label: string; description: string }[] = [
  { id: "statusBar", label: "Status bar", description: "Choose which footer items show and their order" },
];

/**
 * The `/customize` overlay. A small hub routes to per-area editors; the only
 * area today is the status bar. Each editor applies changes live (via onChange)
 * and persists on exit, so the footer reflects edits immediately.
 */
export function CustomizeTUI({ initialLayout, preview, onChange, onExit }: CustomizeTUIProps) {
  const [screen, setScreen] = useState<Screen>("hub");
  // Hold the latest layout so closing from the hub persists edits made in an
  // editor the user then backed out of.
  const [layout, setLayout] = useState<StatusBarLayout>(() =>
    normalizeStatusBarLayout(initialLayout ?? defaultStatusBarLayout()),
  );
  const handleChange = (next: StatusBarLayout) => { setLayout(next); onChange(next); };

  if (screen === "statusBar") {
    return (
      <StatusBarEditor
        initialLayout={layout}
        preview={preview}
        onChange={handleChange}
        onBack={() => setScreen("hub")}
        onExit={onExit}
      />
    );
  }

  return <CustomizeHub onOpen={setScreen} onExit={() => onExit(layout)} />;
}

function CustomizeHub({ onOpen, onExit }: { onOpen: (screen: Screen) => void; onExit: () => void }) {
  const theme = getTheme();
  const [selected, setSelected] = useState(0);

  useInput((_input, key) => {
    if (key.escape) { onExit(); return; }
    if (key.upArrow) { setSelected((i) => (i - 1 + AREAS.length) % AREAS.length); return; }
    if (key.downArrow) { setSelected((i) => (i + 1) % AREAS.length); return; }
    if (key.return) { onOpen(AREAS[selected]!.id); return; }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.bannerColor} paddingX={1}>
      <Text bold color={theme.bannerColor}>Customize Agav</Text>
      <Box marginTop={1} flexDirection="column">
        {AREAS.map((area, index) => {
          const active = index === selected;
          return (
            <Box key={area.id}>
              <Text color={active ? theme.promptColor : undefined}>{active ? "❯ " : "  "}</Text>
              <Text bold={active}>{area.label}</Text>
              <Text dimColor>{"  — "}{area.description}</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ Navigate · Enter Open · Esc Close</Text>
      </Box>
    </Box>
  );
}

function StatusBarEditor({
  initialLayout,
  preview,
  onChange,
  onBack,
  onExit,
}: {
  initialLayout?: StatusBarLayout;
  preview: StatusBarSegments;
  onChange: (layout: StatusBarLayout) => void;
  onBack: () => void;
  onExit: (layout: StatusBarLayout) => void;
}) {
  const theme = getTheme();
  const [layout, setLayout] = useState<StatusBarLayout>(() =>
    normalizeStatusBarLayout(initialLayout ?? defaultStatusBarLayout()),
  );
  const [selected, setSelected] = useState(0);

  // Apply a mutation, keeping the cursor on the same item and pushing the new
  // layout to the live footer.
  const apply = (next: StatusBarLayout, keepIndex = selected) => {
    setLayout(next);
    setSelected(Math.max(0, Math.min(keepIndex, next.length - 1)));
    onChange(next);
  };

  const toggle = (index: number) => {
    apply(layout.map((item, i) => (i === index ? { ...item, enabled: !item.enabled } : item)), index);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= layout.length) return;
    const next = [...layout];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    apply(next, target);
  };

  const restoreDefaults = () => apply(defaultStatusBarLayout(), 0);

  const isDefault = useMemo(() => isDefaultStatusBarLayout(layout), [layout]);

  useInput((input, key) => {
    if (key.escape) { onBack(); return; }
    if (key.return) { onExit(layout); return; }
    if (key.upArrow && key.shift) { move(selected, -1); return; }
    if (key.downArrow && key.shift) { move(selected, 1); return; }
    if (key.upArrow) { setSelected((i) => (i - 1 + layout.length) % layout.length); return; }
    if (key.downArrow) { setSelected((i) => (i + 1) % layout.length); return; }
    if (input === " ") { toggle(selected); return; }
    if (input === "[") { move(selected, -1); return; }
    if (input === "]") { move(selected, 1); return; }
    if (input === "r" || input === "R") { restoreDefaults(); return; }
  });

  const previewText = buildStatusBarText(preview, layout);
  const hintEnabled = isStatusBarItemEnabled(layout, "hint");
  const hintPreview = preview.hint || "Tips appear here";

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.bannerColor} paddingX={1}>
      <Text bold color={theme.bannerColor}>
        Customize · Status bar{isDefault ? "" : " (modified)"}
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Preview</Text>
        <Text dimColor>{previewText || (hintEnabled ? "" : "(all items hidden)")}</Text>
        {hintEnabled && <Text dimColor italic>{"💡 "}{hintPreview}</Text>}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {layout.map((item, index) => {
          const meta = statusBarItemMeta(item.id);
          const active = index === selected;
          return (
            <Box key={item.id}>
              <Text color={active ? theme.promptColor : undefined}>{active ? "❯ " : "  "}</Text>
              <Text color={item.enabled ? theme.promptColor : undefined} dimColor={!item.enabled}>
                {item.enabled ? "[x] " : "[ ] "}
              </Text>
              <Text bold={active} dimColor={!item.enabled}>{meta.label}</Text>
              <Text dimColor>{"  — "}{meta.description}</Text>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>↑/↓ Navigate · Space Show/Hide · [ / ] Move · Shift+↑/↓ Move</Text>
        <Text dimColor>r Restore defaults · Enter Save &amp; close · Esc Back</Text>
      </Box>
    </Box>
  );
}
