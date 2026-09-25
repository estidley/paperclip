import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { transcribeRoutes } from "../routes/transcribe.js";

function createApp(actor: Record<string, unknown>, transcribe = vi.fn(async () => "hello from the mic")) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { actor: typeof actor }).actor = actor;
    next();
  });
  app.use("/api", transcribeRoutes({ transcribe }));
  app.use(errorHandler);
  return { app, transcribe };
}

const boardActor = {
  type: "board",
  userId: "board-user",
  source: "session",
  companyIds: ["company-1"],
  isInstanceAdmin: false,
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
};

describe("transcribe routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transcribes an audio upload for a board member and does not require a send", async () => {
    const { app, transcribe } = createApp(boardActor);
    const res = await request(app)
      .post("/api/companies/company-1/transcribe")
      .attach("audio", Buffer.from("fake-audio"), { filename: "note.webm", contentType: "audio/webm" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "hello from the mic" });
    expect(transcribe).toHaveBeenCalledTimes(1);
    const input = transcribe.mock.calls[0]?.[0];
    expect(input.mimeType).toBe("audio/webm");
    expect(input.filename).toBe("recording.webm");
    expect(Buffer.isBuffer(input.bytes)).toBe(true);
    expect(input.bytes.length).toBeGreaterThan(0);
  });

  it("rejects a request with no audio", async () => {
    const { app, transcribe } = createApp(boardActor);
    const res = await request(app).post("/api/companies/company-1/transcribe");
    expect(res.status).toBe(400);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("rejects an agent key", async () => {
    const { app } = createApp({ type: "agent", companyId: "company-1", agentId: "agent-1" });
    const res = await request(app)
      .post("/api/companies/company-1/transcribe")
      .attach("audio", Buffer.from("fake-audio"), { filename: "note.webm", contentType: "audio/webm" });
    expect(res.status).toBe(403);
  });

  it("rejects a board user from another company", async () => {
    const { app } = createApp({
      ...boardActor,
      companyIds: ["company-2"],
      memberships: [{ companyId: "company-2", status: "active", membershipRole: "member" }],
    });
    const res = await request(app)
      .post("/api/companies/company-1/transcribe")
      .attach("audio", Buffer.from("fake-audio"), { filename: "note.webm", contentType: "audio/webm" });
    expect(res.status).toBe(403);
  });

  it("rejects a viewer", async () => {
    const { app } = createApp({
      ...boardActor,
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "viewer" }],
    });
    const res = await request(app)
      .post("/api/companies/company-1/transcribe")
      .attach("audio", Buffer.from("fake-audio"), { filename: "note.webm", contentType: "audio/webm" });
    expect(res.status).toBe(403);
  });

  it("rejects an unsupported file type", async () => {
    const { app, transcribe } = createApp(boardActor);
    const res = await request(app)
      .post("/api/companies/company-1/transcribe")
      .attach("audio", Buffer.from("not-audio"), { filename: "note.txt", contentType: "text/plain" });
    expect(res.status).toBe(415);
    expect(transcribe).not.toHaveBeenCalled();
  });
});
