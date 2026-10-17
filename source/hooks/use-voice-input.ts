import { useCallback, useEffect, useRef, useState } from "react";
import type { DEFAULT_VOICE_MODEL } from "../utils/voice-model.js";
import type { VoicePhase, VoiceSession } from "../utils/voice-input.js";

export type VoiceUIPhase = VoicePhase | "stopping" | "cancelling" | "model-consent" | "downloading";

/** Lazily start offline dictation; own cancellation through import and cleanup. */
export function useVoiceInput(onTranscript: (text: string) => void, onError: (error: Error) => void, onPartial?: (text: string) => void) {
  const [phase, setPhase] = useState<VoiceUIPhase | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [partialText, setPartialText] = useState("");
  const [model, setModel] = useState<typeof DEFAULT_VOICE_MODEL | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const recordingAt = useRef<number | null>(null);
  const owner = useRef<{ cancelled: boolean; stopped: boolean; acceptsStop: boolean; session?: VoiceSession; controller: AbortController; consent?: (accepted: boolean) => void } | null>(null);
  const callbacks = useRef({ onTranscript, onError, onPartial });
  callbacks.current = { onTranscript, onError, onPartial };
  const mounted = useRef(true);

  const cancel = useCallback(() => {
    if (!owner.current || owner.current.cancelled) return;
    owner.current.cancelled = true;
    owner.current.controller.abort();
    owner.current.consent?.(false);
    if (mounted.current) { setPhase("cancelling"); setLevel(0); }
    owner.current.session?.cancel();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
      // Release the warm context on UI teardown, not only its idle timeout.
      void import("../utils/voice-input.js").then(runtime => runtime.disposeVoiceRuntime?.()).catch(() => {});
    };
  }, [cancel]);
  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => {
      if (recordingAt.current !== null) setElapsedSeconds(Math.min(120, Math.floor((Date.now() - recordingAt.current) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const start = useCallback(() => {
    if (owner.current || !mounted.current) return;
    const operation = { cancelled: false, stopped: false, acceptsStop: false, session: undefined as VoiceSession | undefined, controller: new AbortController(), consent: undefined as ((accepted: boolean) => void) | undefined };
    owner.current = operation;
    // Ink broadcasts the activating Enter to App after the composer handler.
    queueMicrotask(() => { operation.acceptsStop = true; });
    recordingAt.current = null;
    setLevel(0); setElapsedSeconds(0); setPartialText(""); setPhase("preparing");
    void (async () => {
      try {
        const { startVoiceInput } = await import("../utils/voice-input.js");
        if (operation.cancelled || !mounted.current) return;
        if (operation.stopped) throw new Error("No audio recorded: stopped before microphone capture was ready.");
        const models = await import("../utils/voice-model.js");
        if (operation.cancelled || !mounted.current) return;
        const needsModel = !(await models.hasVoiceModel());
        if (needsModel && process.env.AGAV_VOICE_MODEL) throw new Error("AGAV_VOICE_MODEL is invalid. Fix the explicit English-only model path or unset it for setup.");
        const runtimes = await import("../utils/voice-runtime.js");
        if (operation.cancelled || !mounted.current) return;
        // Extract the bundled helper locally; never fetch runtime metadata or binaries.
        await runtimes.ensureVoiceRuntime(operation.controller.signal);
        if (operation.cancelled || !mounted.current) return;
        setModel(needsModel ? models.DEFAULT_VOICE_MODEL : null);
        setDownloadedBytes(0);
        if (needsModel) {
          const consent = new Promise<boolean>(resolve => { operation.consent = resolve; });
          setPhase("model-consent");
          const accepted = await consent;
          operation.consent = undefined;
          if (!accepted || operation.cancelled || !mounted.current) return;
          setPhase("downloading");
          await models.downloadVoiceModel(operation.controller.signal, bytes => {
            if (mounted.current && !operation.cancelled) setDownloadedBytes(bytes);
          });
          if (operation.cancelled || !mounted.current) return;
          setPhase("preparing");
        }
        if (operation.cancelled || !mounted.current) return;
        operation.session = startVoiceInput(next => {
          if (!mounted.current || operation.cancelled) return;
          if (next === "recording" && recordingAt.current === null) recordingAt.current = Date.now();
          setPhase(operation.stopped && next === "recording" ? "stopping" : next);
          if (next !== "recording") setLevel(0);
        }, next => {
          if (mounted.current && !operation.cancelled && !operation.stopped) setLevel(next);
        }, text => {
          if (mounted.current && !operation.cancelled) {
            setPartialText(text);
            callbacks.current.onPartial?.(text);
          }
        });
        const transcript = await operation.session.result;
        if (mounted.current && !operation.cancelled) callbacks.current.onTranscript(transcript);
      } catch (error) {
        if (mounted.current && (!operation.cancelled || (error instanceof Error && error.name === "VoiceCleanupError"))) {
          callbacks.current.onError(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (owner.current === operation) {
          owner.current = null;
          if (mounted.current) { setPhase(null); setLevel(0); setPartialText(""); }
        }
      }
    })();
  }, []);

  const confirmDownload = useCallback(() => {
    if (owner.current && !owner.current.cancelled) owner.current.consent?.(true);
  }, []);
  const stop = useCallback(() => {
    if (!owner.current || owner.current.consent || !owner.current.session || !owner.current.acceptsStop || owner.current.stopped || owner.current.cancelled) return;
    owner.current.stopped = true;
    setPhase(previous => previous === "transcribing" ? previous : "stopping");
    setLevel(0);
    owner.current.session?.stop();
  }, []);
  const isActive = useCallback(() => owner.current !== null, []);
  return { phase, level, partialText, elapsedSeconds, model, downloadedBytes, confirmDownload, start, stop, cancel, isActive };
}
