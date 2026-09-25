import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { resolveTranscriptionConfig, transcribeAudio } from "./transcription.js";

const GROQ_KEY = "gsk_test_key";
const OPENAI_KEY = "sk-test-key";

describe("resolveTranscriptionConfig", () => {
  it("uses Groq whisper-large-v3-turbo when GROQ_API_KEY is set", () => {
    const config = resolveTranscriptionConfig({
      GROQ_API_KEY: GROQ_KEY,
      OPENAI_API_KEY: OPENAI_KEY,
    });
    expect(config).toEqual({
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      apiKey: GROQ_KEY,
    });
  });

  it("falls back to OpenAI gpt-4o-mini-transcribe when only OPENAI_API_KEY is set", () => {
    const config = resolveTranscriptionConfig({ OPENAI_API_KEY: OPENAI_KEY });
    expect(config).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-transcribe",
      apiKey: OPENAI_KEY,
    });
  });

  it("does not default to whisper-1 or whisper-large-v3", () => {
    const groq = resolveTranscriptionConfig({ GROQ_API_KEY: GROQ_KEY });
    const openai = resolveTranscriptionConfig({ OPENAI_API_KEY: OPENAI_KEY });
    expect(groq?.model).not.toBe("whisper-1");
    expect(groq?.model).not.toBe("whisper-large-v3");
    expect(openai?.model).not.toBe("whisper-1");
    expect(openai?.model).not.toBe("whisper-large-v3");
  });

  it("returns null when no provider is configured", () => {
    expect(resolveTranscriptionConfig({})).toBeNull();
  });

  it("honors an explicit base URL, model, and key for a later local server", () => {
    const config = resolveTranscriptionConfig({
      GROQ_API_KEY: GROQ_KEY,
      PAPERCLIP_TRANSCRIBE_BASE_URL: "http://127.0.0.1:8000/v1/",
      PAPERCLIP_TRANSCRIBE_MODEL: "base",
      PAPERCLIP_TRANSCRIBE_API_KEY: "local-key",
    });
    expect(config).toEqual({
      provider: "custom",
      baseUrl: "http://127.0.0.1:8000/v1",
      model: "base",
      apiKey: "local-key",
    });
  });

  it("does not send a cloud key to a custom base URL", () => {
    const config = resolveTranscriptionConfig({
      GROQ_API_KEY: GROQ_KEY,
      OPENAI_API_KEY: OPENAI_KEY,
      PAPERCLIP_TRANSCRIBE_BASE_URL: "http://127.0.0.1:8000/v1",
    });
    expect(config?.provider).toBe("custom");
    expect(config?.apiKey).toBe("");
    expect(config?.model).toBe("whisper-large-v3-turbo");
  });

  it("uses the Groq key when the override URL is Groq", () => {
    const config = resolveTranscriptionConfig({
      GROQ_API_KEY: GROQ_KEY,
      PAPERCLIP_TRANSCRIBE_BASE_URL: "https://api.groq.com/openai/v1",
      PAPERCLIP_TRANSCRIBE_MODEL: "whisper-large-v3-turbo",
    });
    expect(config?.provider).toBe("groq");
    expect(config?.apiKey).toBe(GROQ_KEY);
    expect(config?.model).toBe("whisper-large-v3-turbo");
  });
});

describe("transcribeAudio", () => {
  it("posts the audio to the Groq transcription endpoint and returns text", async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${GROQ_KEY}`);
      const form = init?.body as FormData;
      expect(form.get("model")).toBe("whisper-large-v3-turbo");
      expect(form.get("response_format")).toBe("json");
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("recording.webm");
      return new Response(JSON.stringify({ text: "  hello there  " }), { status: 200 });
    });

    const text = await transcribeAudio(
      { bytes: Buffer.from("audio"), mimeType: "audio/webm", filename: "recording.webm" },
      { env: { GROQ_API_KEY: GROQ_KEY }, fetch: fetchMock as typeof fetch },
    );

    expect(text).toBe("hello there");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the OpenAI mini model when Groq is not configured", async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect((init?.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
      return new Response(JSON.stringify({ text: "fallback" }), { status: 200 });
    });

    const text = await transcribeAudio(
      { bytes: Buffer.from("audio"), mimeType: "audio/webm", filename: "recording.webm" },
      { env: { OPENAI_API_KEY: OPENAI_KEY }, fetch: fetchMock as typeof fetch },
    );
    expect(text).toBe("fallback");
  });

  it("hides the API key when the provider rejects the request", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: `bad key ${OPENAI_KEY}` } }), { status: 401 }),
    );

    await expect(
      transcribeAudio(
        { bytes: Buffer.from("audio"), mimeType: "audio/webm", filename: "recording.webm" },
        { env: { OPENAI_API_KEY: OPENAI_KEY }, fetch: fetchMock as typeof fetch },
      ),
    ).rejects.toMatchObject({
      status: 502,
      message: "bad key [redacted]",
    });
  });

  it("returns 503 when transcription is not configured", async () => {
    await expect(
      transcribeAudio(
        { bytes: Buffer.from("audio"), mimeType: "audio/webm", filename: "recording.webm" },
        { env: {}, fetch: vi.fn() as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(HttpError);
  });
});
