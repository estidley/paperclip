import { Router, type Request, type Response } from "express";
import multer from "multer";
import { badRequest, payloadTooLarge, unsupportedMediaType } from "../errors.js";
import { transcribeAudio, type TranscribeAudioInput } from "../services/transcription.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "video/webm": "webm",
  "video/mp4": "mp4",
};

function normalizeMime(value: string | undefined): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isAllowedAudioMime(mimeType: string): boolean {
  if (!mimeType || mimeType === "application/octet-stream") return true;
  return Object.prototype.hasOwnProperty.call(AUDIO_EXTENSIONS, mimeType);
}

function filenameForMime(mimeType: string): string {
  const extension = AUDIO_EXTENSIONS[mimeType] ?? "webm";
  return `recording.${extension}`;
}

function readAudioUpload(req: Request, res: Response): Promise<void> {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  }).single("audio");
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

export function transcribeRoutes(deps?: {
  transcribe?: (input: TranscribeAudioInput) => Promise<string>;
}) {
  const transcribe = deps?.transcribe ?? transcribeAudio;
  const router = Router();

  router.post("/companies/:companyId/transcribe", async (req, res) => {
    const companyId = String(req.params.companyId ?? "");
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    try {
      await readAudioUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        throw payloadTooLarge("Audio file exceeds 25 MB");
      }
      if (err instanceof multer.MulterError) {
        throw badRequest("Audio file is required");
      }
      throw err;
    }

    const file = req.file;
    if (!file || file.buffer.length === 0) throw badRequest("Audio file is required");

    const mimeType = normalizeMime(file.mimetype) || "audio/webm";
    if (!isAllowedAudioMime(mimeType)) {
      throw unsupportedMediaType("Unsupported audio type");
    }

    const text = await transcribe({
      bytes: file.buffer,
      mimeType,
      filename: filenameForMime(mimeType),
    });
    res.json({ text });
  });

  return router;
}
