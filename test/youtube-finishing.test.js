import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { YouTubeUploadStore } from "../src/youtube-uploads.js";
import { deterministicThumbnailTimestamps, validateCustomTimestamp, YouTubeFinishingService } from "../src/youtube-finishing.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-finishing-")); t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output"); const videos = path.join(output, "compilation-videos"); await mkdir(videos, { recursive: true });
  const content = Buffer.from("exact-private-compilation"); await writeFile(path.join(videos, "current.mp4"), content);
  const fingerprint = crypto.createHash("sha256").update(content).digest("hex");
  const store = new YouTubeUploadStore(output, "oauth-client-secret"); await store.initialize();
  const base = { id: "current", sourceFilename: "current.mp4", sourceFingerprint: fingerprint, sourceSize: content.length, sourceDuration: 120, visibility: "private", channelId: "UC-safe", channelName: "Safe Channel", status: "Completed", uploadedBytes: content.length, youtubeVideoId: "video-current", youtubeStudioUrl: "https://studio.youtube.com/video/video-current/edit", disclosureStatus: "Verified", audienceStatus: "SubmittedUnverified", createdAt: "2026-11-02T00:00:00Z", updatedAt: "2026-11-02T00:00:00Z", title: "Current compilation", uploadKind: "compilation" };
  await store.create({ ...base, ...overrides.record });
  const calls = { ffmpeg: [], thumbnails: [], list: [] };
  const youtube = overrides.youtube ?? { videos: { async list(args) { calls.list.push(args); return { data: { items: [{ id: "video-current", status: { selfDeclaredMadeForKids: false, containsSyntheticMedia: true } }] } }; } }, thumbnails: { async set(args) { calls.thumbnails.push(args); return { data: { items: [{ default: { url: "https://example.invalid/thumb.jpg" } }] } }; } } };
  const connection = { async getVerifiedReadContext() { return { channel: { id: overrides.channelId ?? "UC-safe" }, youtube }; }, async getVerifiedUploadContext() { return { channel: { id: overrides.channelId ?? "UC-safe" }, youtube }; } };
  const runner = { async run(command, args) { calls.ffmpeg.push({ command, args }); if (overrides.ffmpegError) throw new Error("ffmpeg failed"); await writeFile(args.at(-1), "jpeg-candidate"); } };
  const probe = async (file) => file.endsWith(".jpg") ? { streams: [{ codecType: "video", codecName: overrides.codecName ?? "mjpeg", width: 1920, height: 1080 }] } : { duration: 120, streams: [{ codecType: "video", codecName: "h264", duration: 120 }] };
  const service = new YouTubeFinishingService(output, connection, store, { runner, probe, now: () => new Date("2026-11-05T12:00:00Z") }); await service.initialize();
  return { output, store, service, calls, base };
}

test("six deterministic samples avoid the beginning and end and custom timestamps are bounded", () => {
  const samples = deterministicThumbnailTimestamps(120); assert.equal(samples.length, 6); assert.deepEqual(samples, [...samples].sort((a, b) => a - b)); assert.ok(samples[0] > 5); assert.ok(samples.at(-1) < 115);
  assert.equal(validateCustomTimestamp("33.125", 120), 33.125); assert.throws(() => validateCustomTimestamp(1, 120), /between/); assert.throws(() => validateCustomTimestamp(119, 120), /between/);
});

test("existing completed records select only the latest earlier compilation and persist manual end-screen confirmation", async (t) => {
  const values = await fixture(t); await values.store.create({ ...values.base, id: "previous", title: "Previous", youtubeVideoId: "video-previous", sourceFilename: "older.mp4", createdAt: "2026-11-01T00:00:00Z" }); await values.store.create({ ...values.base, id: "individual", title: "Individual", youtubeVideoId: "video-track", uploadKind: "individual", createdAt: "2026-11-01T12:00:00Z" });
  await values.service.discover(); let record = values.service.get(values.base.id); assert.equal(record.previousCompilation.videoId, "video-previous"); assert.equal(record.endScreen.status, "Pending"); assert.equal(values.store.get(values.base.id).endScreen.sourceVideoId, "video-previous");
  record = await values.service.confirmEndScreen(values.base.id); assert.equal(record.endScreen.status, "Completed"); assert.equal(record.endScreen.sourceVideoId, "video-previous"); assert.ok(record.endScreen.confirmedAt);
  assert.equal(values.service.get("individual").endScreen.status, "NotApplicable");
});

test("a compilation with no previous source is not applicable and cannot be falsely confirmed", async (t) => {
  const values = await fixture(t); assert.equal(values.service.get(values.base.id).endScreen.status, "NotApplicable"); await assert.rejects(() => values.service.confirmEndScreen(values.base.id), /No previous/);
});

test("extracts and validates six JPEG candidates from the exact unchanged MP4", async (t) => {
  const values = await fixture(t); const record = await values.service.generateCandidates(values.base.id); assert.equal(record.candidates.length, 6); assert.equal(values.calls.ffmpeg.length, 6); assert.ok(values.calls.ffmpeg.every((call) => call.args.includes("-frames:v") && !call.args.includes("-vf")));
  assert.match(record.candidates[0].previewUrl, /candidates\/frame-/); await values.service.generateCandidates(values.base.id, 42.25); assert.equal(values.service.get(values.base.id).candidates.length, 7);
});

test("blocks extraction when the source fingerprint changes and reports FFmpeg and JPEG failures", async (t) => {
  const changed = await fixture(t); await writeFile(path.join(changed.output, "compilation-videos", "current.mp4"), "different-but-longer-content"); await assert.rejects(() => changed.service.generateCandidates(changed.base.id), /missing or changed|fingerprint/);
  const ffmpeg = await fixture(t, { ffmpegError: true }); await assert.rejects(() => ffmpeg.service.generateCandidates(ffmpeg.base.id), /ffmpeg failed/);
  const invalid = await fixture(t, { codecName: "png" }); await assert.rejects(() => invalid.service.generateCandidates(invalid.base.id), /valid JPEG/);
});

test("thumbnail approval binds exact video, channel, source and candidate before one API call", async (t) => {
  const values = await fixture(t); await values.service.generateCandidates(values.base.id); const candidate = values.service.get(values.base.id).candidates[0]; const plan = await values.service.planThumbnail(values.base.id, candidate.id);
  assert.equal(plan.youtubeVideoId, "video-current"); assert.equal(plan.channelId, "UC-safe"); assert.equal(plan.visibility, "private"); await assert.rejects(() => values.service.uploadThumbnail({ recordId: values.base.id, candidateId: candidate.id, snapshot: "stale" }), /changed/); assert.equal(values.calls.thumbnails.length, 0);
  const completed = await values.service.uploadThumbnail({ recordId: values.base.id, candidateId: candidate.id, snapshot: plan.snapshot }); assert.equal(values.calls.thumbnails.length, 1); assert.equal(values.calls.thumbnails[0].videoId, "video-current"); assert.equal(completed.thumbnailState.status, "Completed"); assert.match(completed.thumbnailState.message, /visibility may take time/i);
});

test("thumbnail API failure is persisted and the same candidate can be explicitly retried", async (t) => {
  let fail = true; const youtube = { videos: { async list() { return { data: { items: [] } }; } }, thumbnails: { async set() { if (fail) { const error = new Error("forbidden"); error.code = 403; throw error; } return { data: { items: [{}] } }; } } };
  const values = await fixture(t, { youtube }); await values.service.generateCandidates(values.base.id); const candidate = values.service.get(values.base.id).candidates[0]; let plan = await values.service.planThumbnail(values.base.id, candidate.id); await assert.rejects(() => values.service.uploadThumbnail({ recordId: values.base.id, candidateId: candidate.id, snapshot: plan.snapshot }), /custom-thumbnail eligibility/); assert.equal(values.service.get(values.base.id).thumbnailState.status, "Failed");
  fail = false; plan = await values.service.planThumbnail(values.base.id, candidate.id); assert.equal((await values.service.uploadThumbnail({ recordId: values.base.id, candidateId: candidate.id, snapshot: plan.snapshot })).thumbnailState.status, "Completed");
});

test("thumbnail upload admission permits only one concurrent API request", async (t) => {
  let release; const held = new Promise((resolve) => { release = resolve; }); let started; const startedPromise = new Promise((resolve) => { started = resolve; }); let calls = 0;
  const youtube = { videos: { async list() { return { data: { items: [] } }; } }, thumbnails: { async set() { calls += 1; started(); await held; return { data: { items: [{}] } }; } } };
  const values = await fixture(t, { youtube }); await values.service.generateCandidates(values.base.id); const candidate = values.service.get(values.base.id).candidates[0]; const plan = await values.service.planThumbnail(values.base.id, candidate.id);
  const first = values.service.uploadThumbnail({ recordId: values.base.id, candidateId: candidate.id, snapshot: plan.snapshot }); const second = values.service.uploadThumbnail({ recordId: values.base.id, candidateId: candidate.id, snapshot: plan.snapshot });
  await assert.rejects(second, /already active/); await startedPromise; assert.equal(calls, 1); release(); await first; assert.equal(calls, 1);
});

test("declaration review distinguishes verified, submitted-unverified, mismatch, and channel conflict", async (t) => {
  const values = await fixture(t); let record = await values.service.refreshDeclarations(values.base.id); assert.equal(record.audienceStatus, "Verified"); assert.equal(record.disclosureStatus, "Verified");
  const mismatchYoutube = { videos: { async list() { return { data: { items: [{ id: "video-current", status: { selfDeclaredMadeForKids: true } }] } }; } }, thumbnails: { async set() {} } }; const mismatch = await fixture(t, { youtube: mismatchYoutube }); record = await mismatch.service.refreshDeclarations(mismatch.base.id); assert.equal(record.audienceStatus, "Mismatch"); assert.equal(record.disclosureStatus, "SubmittedUnverified");
  const wrong = await fixture(t, { channelId: "UC-other" }); await assert.rejects(() => wrong.service.refreshDeclarations(wrong.base.id), /channel does not match/);
});
