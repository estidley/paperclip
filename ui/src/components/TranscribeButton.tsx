import { useEffect, useRef, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { ApiError, api } from "@/api/client";
import { useOptionalCompany } from "@/context/CompanyContext";
import { useOptionalToastActions } from "@/context/ToastContext";
import { cn } from "@/lib/utils";

type Phase = "idle" | "recording" | "transcribing";

export interface TranscribeButtonProps {
  disabled?: boolean;
  /** Overrides the selected company from context. */
  companyId?: string | null;
  /** Insert the transcript. The caller must not send the message. */
  onTranscript: (text: string) => void;
  className?: string;
}

function preferredMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function filenameForMime(mimeType: string): string {
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (base.includes("mp4") || base.includes("m4a")) return "recording.m4a";
  if (base.includes("ogg")) return "recording.ogg";
  if (base.includes("wav")) return "recording.wav";
  return "recording.webm";
}

function microphoneMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Allow microphone access to transcribe.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone was found.";
  }
  return "Could not start recording.";
}

export function TranscribeButton({
  disabled = false,
  companyId: companyIdProp,
  onTranscript,
  className,
}: TranscribeButtonProps) {
  const company = useOptionalCompany();
  const toast = useOptionalToastActions();
  const companyId = companyIdProp ?? company?.selectedCompanyId ?? null;
  const [phase, setPhase] = useState<Phase>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const cancelledRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  const companyIdRef = useRef(companyId);
  onTranscriptRef.current = onTranscript;
  companyIdRef.current = companyId;

  function reportError(title: string, body: string) {
    toast?.pushToast({ title, body, tone: "error" });
  }

  function stopStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      stopStream();
    };
  }, []);

  async function sendRecording(blob: Blob) {
    if (cancelledRef.current) return;
    if (blob.size === 0) {
      setPhase("idle");
      reportError("Nothing to transcribe", "The recording was empty.");
      return;
    }
    const activeCompanyId = companyIdRef.current;
    if (!activeCompanyId) {
      setPhase("idle");
      reportError("No company selected", "Select a company before transcribing.");
      return;
    }

    setPhase("transcribing");
    try {
      const form = new FormData();
      form.append("audio", blob, filenameForMime(blob.type));
      const result = await api.postForm<{ text: string }>(
        `/companies/${activeCompanyId}/transcribe`,
        form,
      );
      if (cancelledRef.current) return;
      const text = result.text?.trim() ?? "";
      if (!text) {
        reportError("No speech detected", "Try recording again.");
        return;
      }
      onTranscriptRef.current(text);
    } catch (error) {
      if (cancelledRef.current) return;
      const message = error instanceof ApiError ? error.message : "Transcription failed.";
      reportError("Transcription failed", message);
    } finally {
      if (!cancelledRef.current) setPhase("idle");
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      reportError("Microphone unavailable", "This browser cannot record audio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const recordedType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: recordedType });
        stopStream();
        recorderRef.current = null;
        void sendRecording(blob);
      };
      recorder.start();
      setPhase("recording");
    } catch (error) {
      stopStream();
      reportError("Microphone unavailable", microphoneMessage(error));
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setPhase("idle");
      return;
    }
    recorder.stop();
  }

  const busy = phase === "transcribing";
  const label =
    phase === "recording" ? "Stop recording" : busy ? "Transcribing" : "Transcribe";

  return (
    <button
      type="button"
      data-testid="transcribe-button"
      data-state={phase}
      aria-label={label}
      aria-pressed={phase === "recording"}
      title={phase === "recording" ? "Stop and transcribe" : busy ? "Transcribing…" : "Transcribe"}
      disabled={(disabled && phase !== "recording") || busy}
      onClick={() => {
        if (busy) return;
        if (phase === "recording") {
          stopRecording();
          return;
        }
        if (disabled) return;
        void startRecording();
      }}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        phase === "recording" && "animate-pulse bg-destructive/15 text-destructive hover:bg-destructive/20 hover:text-destructive",
        className,
      )}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
    </button>
  );
}
