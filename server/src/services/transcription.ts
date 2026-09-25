import { HttpError } from "../errors.js";

const GROQ_TRANSCRIPTION_BASE_URL = "https://api.groq.com/openai/v1";
const OPENAI_TRANSCRIPTION_BASE_URL = "https://api.openai.com/v1";
const GROQ_DEFAULT_MODEL = "whisper-large-v3-turbo";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_TIMEOUT_MS = 45_000;

export type TranscriptionProvider = "groq" | "openai" | "custom";

export interface TranscriptionConfig {
  provider: TranscriptionProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface TranscribeAudioInput {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

export interface TranscribeAudioOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? "";
}

function providerForBaseUrl(baseUrl: string): TranscriptionProvider {
  let hostname = "";
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "custom";
  }
  if (hostname === "api.groq.com" || hostname.endsWith(".groq.com")) return "groq";
  if (hostname === "api.openai.com") return "openai";
  return "custom";
}

function defaultModel(provider: TranscriptionProvider): string {
  if (provider === "openai") return OPENAI_DEFAULT_MODEL;
  return GROQ_DEFAULT_MODEL;
}

/**
 * Pick the speech-to-text endpoint.
 *
 * Groq `whisper-large-v3-turbo` wins when `GROQ_API_KEY` is set.
 * OpenAI `gpt-4o-mini-transcribe` is the fallback when only `OPENAI_API_KEY` is set.
 * `PAPERCLIP_TRANSCRIBE_BASE_URL` / `_MODEL` / `_API_KEY` override both, so a
 * local OpenAI-compatible server can replace the cloud call later.
 */
export function resolveTranscriptionConfig(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionConfig | null {
  const explicitBase = trimmed(env.PAPERCLIP_TRANSCRIBE_BASE_URL).replace(/\/+$/, "");
  const explicitModel = trimmed(env.PAPERCLIP_TRANSCRIBE_MODEL);
  const explicitKey = trimmed(env.PAPERCLIP_TRANSCRIBE_API_KEY);
  const groqKey = trimmed(env.GROQ_API_KEY);
  const openaiKey = trimmed(env.OPENAI_API_KEY);

  let baseUrl = explicitBase;
  if (!baseUrl) {
    if (groqKey) baseUrl = GROQ_TRANSCRIPTION_BASE_URL;
    else if (openaiKey) baseUrl = OPENAI_TRANSCRIPTION_BASE_URL;
    else return null;
  }

  const provider = providerForBaseUrl(baseUrl);
  const apiKey =
    explicitKey ||
    (provider === "groq" ? groqKey : provider === "openai" ? openaiKey : "");
  if ((provider === "groq" || provider === "openai") && !apiKey) return null;

  return {
    provider,
    baseUrl,
    model: explicitModel || defaultModel(provider),
    apiKey,
  };
}

function transcriptionEndpoint(baseUrl: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL("audio/transcriptions", `${baseUrl.replace(/\/+$/, "")}/`);
  } catch {
    throw new HttpError(503, "PAPERCLIP_TRANSCRIBE_BASE_URL is not a valid URL.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new HttpError(503, "PAPERCLIP_TRANSCRIBE_BASE_URL must use http or https.");
  }
  if (endpoint.username || endpoint.password) {
    throw new HttpError(503, "PAPERCLIP_TRANSCRIBE_BASE_URL must not include credentials.");
  }
  return endpoint;
}

function upstreamErrorMessage(payload: unknown, status: number): string {
  let message = "";
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") message = error;
    else if (
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
    ) {
      message = (error as { message: string }).message;
    }
  }
  message = message
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/gsk_[A-Za-z0-9_-]+/g, "[redacted]")
    .trim();
  if (!message) return `Transcription failed (${status}).`;
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}

function readTranscript(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
}

export async function transcribeAudio(
  input: TranscribeAudioInput,
  options: TranscribeAudioOptions = {},
): Promise<string> {
  const config = resolveTranscriptionConfig(options.env ?? process.env);
  if (!config) {
    throw new HttpError(
      503,
      "Transcription is not configured. Set GROQ_API_KEY, OPENAI_API_KEY, or PAPERCLIP_TRANSCRIBE_BASE_URL.",
    );
  }

  const endpoint = transcriptionEndpoint(config.baseUrl);
  const file = new File([new Uint8Array(input.bytes)], input.filename, {
    type: input.mimeType || "application/octet-stream",
  });
  const form = new FormData();
  form.set("file", file);
  form.set("model", config.model);
  form.set("response_format", "json");

  const headers: Record<string, string> = {};
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new HttpError(
      502,
      timedOut ? "Transcription timed out." : "Transcription service is unavailable.",
    );
  }

  const raw = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }
    throw new HttpError(502, upstreamErrorMessage(payload, response.status));
  }

  if (!raw.trim()) return "";
  try {
    return readTranscript(JSON.parse(raw));
  } catch {
    return raw.trim();
  }
}
