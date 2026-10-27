import React, { useState } from "react";
import { Box, Text, useInput, usePaste } from "../ink/index.js";
import { isEscapeResidue } from "./input-prompt.js";
import { EFFORT_LEVELS, type EffortLevel } from "../config/config.js";
import type { ModelSuggestion } from "../utils/model-suggestion.js";
import { formatContextWindow, type FetchedModel } from "../commands/model.js";

export interface SessionSetupChoice {
  /** The chosen model, or undefined to keep the current one. */
  model?: string;
  /** Provider that serves the chosen model, when picked from the catalog. */
  provider?: string;
  effort: EffortLevel;
}

interface Props {
  /** The AI's recommendation; null when the provider cannot offer one. */
  suggestion: ModelSuggestion | null;
  currentModel: string;
  currentProvider: string;
  currentEffort: EffortLevel;
  /** Skip the model step when the org has pinned the model. */
  modelLocked?: boolean;
  /** Lists the models available across configured providers. */
  loadModels: () => Promise<FetchedModel[]>;
  onSubmit: (choice: SessionSetupChoice) => void;
}

type ModelOption = "ai" | "current" | "custom";
type ChosenModel = { id: string; provider?: string };

const LIST_ROWS = 8;

/**
 * Shown before the first turn of a conversation. Step one asks whether the AI
 * should assign the model, the current one should be kept, or one picked from
 * the available models; step two asks for the reasoning effort. Esc keeps the
 * current value at each step.
 */
export default function ModelSuggestionPrompt({
  suggestion, currentModel, currentProvider, currentEffort, modelLocked, loadModels, onSubmit,
}: Props) {
  const modelOptions: ModelOption[] = suggestion ? ["ai", "current", "custom"] : ["current", "custom"];
  const [step, setStep] = useState<"model" | "effort">(modelLocked ? "effort" : "model");
  const [selected, setSelected] = useState(0);
  const [browsing, setBrowsing] = useState(false);
  const [models, setModels] = useState<FetchedModel[] | null>(null);
  const [filter, setFilter] = useState("");
  const [listIndex, setListIndex] = useState(0);
  const [model, setModel] = useState<ChosenModel | undefined>(undefined);
  const recommendedEffort = suggestion && model?.id === suggestion.model ? suggestion.effort : undefined;

  const lowerFilter = filter.trim().toLowerCase();
  const filtered = (models ?? []).filter((m) => !lowerFilter
    || m.id.toLowerCase().includes(lowerFilter) || m.provider.toLowerCase().includes(lowerFilter));

  const goToEffort = (chosen: ChosenModel | undefined) => {
    setModel(chosen);
    setBrowsing(false);
    const preferred = suggestion && chosen?.id === suggestion.model ? suggestion.effort : currentEffort;
    setSelected(EFFORT_LEVELS.indexOf(preferred));
    setStep("effort");
  };

  const startBrowsing = () => {
    setSelected(modelOptions.indexOf("custom"));
    setBrowsing(true);
    setFilter("");
    setListIndex(0);
    if (models === null) {
      loadModels()
        .then((list) => {
          setModels(list);
          setListIndex(Math.max(0, list.findIndex((m) => m.id === currentModel)));
        })
        .catch(() => setModels([]));
    }
  };

  const pickModel = (option: ModelOption | undefined) => {
    if (option === "ai") goToEffort({ id: suggestion!.model });
    else if (option === "current") goToEffort(undefined);
    else if (option === "custom") startBrowsing();
  };

  useInput((input, key) => {
    if (browsing) {
      if (key.escape) return setBrowsing(false);
      if (key.upArrow) return setListIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) return setListIndex((i) => Math.min(Math.max(0, filtered.length - 1), i + 1));
      if (key.return) {
        const picked = filtered[listIndex];
        // Nothing listed matches: treat the filter text as a model id.
        if (picked) goToEffort({ id: picked.id, provider: picked.provider });
        else if (filter.trim()) goToEffort({ id: filter.trim() });
        return;
      }
      if (key.backspace || key.delete) {
        setFilter((prev) => prev.slice(0, -1));
        setListIndex(0);
        return;
      }
      if (input && !key.ctrl && !key.meta && !isEscapeResidue(input)) {
        setFilter((prev) => prev + input);
        setListIndex(0);
      }
      return;
    }

    const count = step === "model" ? modelOptions.length : EFFORT_LEVELS.length;
    if (key.upArrow) return setSelected((i) => (i + count - 1) % count);
    if (key.downArrow || key.tab) return setSelected((i) => (i + 1) % count);
    const digit = Number(input);
    const index = key.return ? selected : digit >= 1 && digit <= count ? digit - 1 : -1;

    if (step === "model") {
      if (key.escape) return goToEffort(undefined);
      if (index >= 0) pickModel(modelOptions[index]);
      return;
    }
    if (key.escape) return onSubmit({ model: model?.id, provider: model?.provider, effort: currentEffort });
    if (index >= 0) onSubmit({ model: model?.id, provider: model?.provider, effort: EFFORT_LEVELS[index]! });
  });

  usePaste((text) => {
    if (browsing) {
      setFilter((prev) => prev + text.replace(/\s+/g, ""));
      setListIndex(0);
    }
  });

  const modelLabels: Record<ModelOption, string> = {
    ai: `Let the AI assign it: ${suggestion?.model ?? ""} (recommended)`,
    current: `Keep current: ${currentModel}`,
    custom: "Choose from available models…",
  };
  const labels = step === "model"
    ? modelOptions.map((option) => modelLabels[option])
    : EFFORT_LEVELS.map((level) => {
      const tags = [level === recommendedEffort && "recommended", level === currentEffort && "current"].filter(Boolean);
      return tags.length ? `${level} (${tags.join(", ")})` : level;
    });

  const scrollStart = Math.max(0, Math.min(listIndex - Math.floor(LIST_ROWS / 2), filtered.length - LIST_ROWS));
  const visible = filtered.slice(scrollStart, scrollStart + LIST_ROWS);

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {step === "model" ? (
        <>
          <Text bold color="yellow">Which model should handle this conversation?</Text>
          {suggestion && (
            <Text dimColor>
              {suggestion.source === "ai" ? "AI" : "Heuristic"} recommends {suggestion.model} ({suggestion.tier}): {suggestion.reason}
            </Text>
          )}
        </>
      ) : (
        <>
          <Text bold color="yellow">What reasoning effort should it use?</Text>
          <Text dimColor>Model: {model?.id ?? currentModel}</Text>
        </>
      )}
      {browsing ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Filter: <Text color="cyan">{filter}</Text><Text color="cyan">█</Text>
            {models !== null && <Text dimColor>  ({filtered.length} of {models.length})</Text>}
          </Text>
          {models === null && <Text dimColor>Fetching available models…</Text>}
          {models !== null && filtered.length === 0 && (
            <Text dimColor>
              {filter.trim() ? `No listed model matches. Enter uses "${filter.trim()}" as the model id.` : "No models found. Type a model id."}
            </Text>
          )}
          {visible.map((m, i) => {
            const isSel = scrollStart + i === listIndex;
            const tags = [
              m.contextWindow ? `${formatContextWindow(m.contextWindow)} ctx` : "",
              m.provider !== currentProvider ? m.provider : "",
              m.id === currentModel ? "current" : "",
            ].filter(Boolean).join(" · ");
            return (
              <Text key={`${m.provider}:${m.id}`} color={isSel ? "cyan" : undefined} dimColor={!isSel}>
                {isSel ? "❯ " : "  "}{m.id}{tags ? ` (${tags})` : ""}
              </Text>
            );
          })}
          {filtered.length > LIST_ROWS && (
            <Text dimColor>{scrollStart + 1}-{scrollStart + visible.length} of {filtered.length}</Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {labels.map((label, i) => (
            <Text key={label} color={i === selected ? "cyan" : undefined}>
              {i === selected ? "❯ " : "  "}
              {i + 1}. {label}
            </Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          {browsing
            ? "↑↓ navigate · Type to filter · Enter select · Esc back"
            : `↑↓ or 1-${labels.length} to choose · Enter to confirm · Esc to keep current`}
        </Text>
        <Text dimColor>Tip: you can change these anytime with /model, /effort, /fast or /deep.</Text>
      </Box>
    </Box>
  );
}
