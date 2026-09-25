// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { ToastProvider } from "@/context/ToastContext";
import { ToastViewport } from "./ToastViewport";
import { TranscribeButton } from "./TranscribeButton";

const postForm = vi.hoisted(() => vi.fn());

vi.mock("@/api/client", () => ({
  api: { postForm },
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body: unknown) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio-bytes"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function installMedia() {
  const stop = vi.fn();
  vi.stubGlobal("MediaRecorder", Object.assign(FakeRecorder, {
    isTypeSupported: (value: string) => value.startsWith("audio/webm"),
  }));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop }],
      })),
    },
  });
  return stop;
}

function Harness({
  onSubmit,
  initial = "",
}: {
  onSubmit: () => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ToastProvider>
      <textarea data-testid="draft" value={value} onChange={(event) => setValue(event.target.value)} />
      <TranscribeButton
        companyId="company-1"
        onTranscript={(text) => {
          setValue((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
        }}
      />
      <button type="button" aria-label="Send message" onClick={onSubmit}>
        Send
      </button>
      <ToastViewport />
    </ToastProvider>
  );
}

describe("TranscribeButton", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    postForm.mockReset();
    installMedia();
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  function button() {
    return container.querySelector<HTMLButtonElement>('[data-testid="transcribe-button"]')!;
  }

  async function click(target: HTMLButtonElement) {
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("records, stops, and inserts the transcript without sending", async () => {
    postForm.mockResolvedValue({ text: "ship the notes" });
    const onSubmit = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness onSubmit={onSubmit} initial="Please" />);
    });

    await click(button());
    expect(button().getAttribute("data-state")).toBe("recording");
    expect(button().getAttribute("aria-pressed")).toBe("true");

    await click(button());
    expect(postForm).toHaveBeenCalledTimes(1);
    expect(postForm.mock.calls[0]?.[0]).toBe("/companies/company-1/transcribe");
    const form = postForm.mock.calls[0]?.[1] as FormData;
    expect(form.get("audio")).toBeInstanceOf(Blob);
    expect(container.querySelector("textarea")!.value).toBe("Please ship the notes");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button().getAttribute("data-state")).toBe("idle");
    await act(async () => root.unmount());
  });

  it("shows an error toast when the microphone is denied", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException("denied", "NotAllowedError");
        }),
      },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness onSubmit={vi.fn()} />);
    });
    await click(button());
    expect(container.textContent).toContain("Microphone unavailable");
    expect(container.textContent).toContain("Allow microphone access to transcribe.");
    expect(postForm).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("shows an error toast when transcription fails", async () => {
    postForm.mockRejectedValue(new ApiError("Transcription is not configured. Set GROQ_API_KEY, OPENAI_API_KEY, or PAPERCLIP_TRANSCRIBE_BASE_URL.", 503, null));
    const onSubmit = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<Harness onSubmit={onSubmit} />);
    });
    await click(button());
    await click(button());
    expect(container.textContent).toContain("Transcription failed");
    expect(container.textContent).toContain("GROQ_API_KEY");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(container.querySelector("textarea")!.value).toBe("");
    await act(async () => root.unmount());
  });
});
