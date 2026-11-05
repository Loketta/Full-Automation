import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { YouTubeUploadService, YouTubeUploadStore } from "../src/youtube-uploads.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-upload-")); t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output"); const sourceDirectory = path.join(output, "compilation-videos"); await mkdir(sourceDirectory, { recursive: true });
  const filename = "industrial.mp4"; await writeFile(path.join(sourceDirectory, filename), overrides.content ?? "0123456789");
  const store = overrides.store ?? new YouTubeUploadStore(output, "oauth-client-secret", { randomBytes: (size) => Buffer.alloc(size, 3) });
  const connection = overrides.connection ?? { async getVerifiedUploadContext() { return { channel: { id: "UC-destination", name: "Destination", handle: "@destination" }, getAccessToken: async () => "temporary-access" }; } };
  const calls = { sessions: [], chunks: [], queries: [] };
  const transport = overrides.transport ?? {
    async createSession(values) { calls.sessions.push(values); return { sessionUrl: "https://upload.test/sensitive-session" }; },
    async uploadChunk(values) { calls.chunks.push(values); return values.end + 1 === values.total ? { status: 201, completed: true, data: { id: "video-123", status: { containsSyntheticMedia: true } } } : { status: 308, range: `bytes=0-${values.end}` }; },
    async querySession(values) { calls.queries.push(values); return { status: 308, range: undefined }; },
  };
  const service = new YouTubeUploadService(output, connection, store, { transport, chunkSize: overrides.chunkSize ?? 4, probe: async () => ({ duration: 3640.15, streams: [{ codecType: "video" }, { codecType: "audio" }] }), randomUUID: () => "upload-1", now: () => new Date("2026-11-03T12:00:00Z"), sleep: overrides.sleep ?? (async () => {}) });
  await service.initialize();
  return { root, output, filename, store, connection, transport, service, calls };
}

async function approvedPlan(values, extra = {}) {
  return values.service.plan({ filename: values.filename, title: "Industrial Afterhours", description: "One hour compilation", tags: "cyberpunk, industrial", ...extra });
}

test("plan binds exact private metadata, source fingerprint, and verified channel", async (t) => {
  const values = await fixture(t); const plan = await approvedPlan(values);
  assert.equal(plan.visibility, "private"); assert.equal(plan.containsSyntheticMedia, true); assert.match(plan.disclosureReason, /Lyria/); assert.equal(plan.channel.id, "UC-destination"); assert.equal(plan.source.duration, 3640.15); assert.equal(plan.source.size, 10); assert.match(plan.source.fingerprint, /^[a-f0-9]{64}$/); assert.ok(plan.snapshot);
  assert.deepEqual(plan.tags, ["cyberpunk", "industrial"]);
});

test("streams bounded chunks, reports progress, and records only private completion", async (t) => {
  const values = await fixture(t); const plan = await approvedPlan(values);
  const started = await values.service.start({ filename: values.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot });
  assert.equal(started.visibility, "private"); await values.service.waitForIdle();
  const record = values.service.list()[0]; assert.equal(record.status, "Completed"); assert.equal(record.youtubeVideoId, "video-123"); assert.equal(record.youtubeVideoUrl, "https://www.youtube.com/watch?v=video-123"); assert.equal(record.youtubeStudioUrl, "https://studio.youtube.com/video/video-123/edit"); assert.equal(record.disclosureStatus, "Verified"); assert.equal(record.readyForPublicRelease, true); assert.equal(record.progressPercent, 100);
  assert.equal(values.calls.sessions.length, 1); assert.deepEqual(values.calls.sessions[0].metadata.status, { privacyStatus: "private", containsSyntheticMedia: true }); assert.equal("selfDeclaredMadeForKids" in values.calls.sessions[0].metadata.status, false);
  assert.deepEqual(values.calls.chunks.map((call) => call.body.length), [4, 4, 2]); assert.ok(values.calls.chunks.every((call) => call.body.length <= 4));
  const disk = await readFile(path.join(values.output, "youtube-upload-records.enc"), "utf8"); assert.doesNotMatch(disk, /sensitive-session|temporary-access|video-123|Industrial/);
});

test("an unreturned disclosure remains outstanding until explicit Studio confirmation persists", async (t) => {
  const values = await fixture(t, { transport: { async createSession() { return { sessionUrl: "https://upload.test/session" }; }, async uploadChunk() { return { status: 201, completed: true, data: { id: "manual-review" } }; } } }); const plan = await approvedPlan(values);
  await values.service.start({ filename: values.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot }); await values.service.waitForIdle();
  let record = values.service.list()[0]; assert.equal(record.disclosureStatus, "SubmittedUnverified"); assert.equal(record.readyForPublicRelease, false); assert.match(record.message, /verify it in YouTube Studio/i);
  record = await values.service.confirmDisclosure(record.id); assert.equal(record.disclosureStatus, "ManuallyConfirmed"); assert.equal(record.readyForPublicRelease, true);
  const restarted = new YouTubeUploadService(values.output, values.connection, new YouTubeUploadStore(values.output, "oauth-client-secret", { randomBytes: (size) => Buffer.alloc(size, 3) }), { transport: values.transport, probe: async () => ({ duration: 3640.15, streams: [{ codecType: "video" }, { codecType: "audio" }] }) }); await restarted.initialize(); assert.equal(restarted.list()[0].disclosureStatus, "ManuallyConfirmed");
});

test("source modification and channel changes invalidate approval before session creation", async (t) => {
  const values = await fixture(t); const plan = await approvedPlan(values); await writeFile(path.join(values.output, "compilation-videos", values.filename), "changed-content");
  await assert.rejects(() => values.service.start({ filename: values.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot }), /changed/);
  assert.equal(values.calls.sessions.length, 0);
  const second = await fixture(t, { connection: { async getVerifiedUploadContext() { return { channel: { id: "UC-other", name: "Other" }, getAccessToken: async () => "token" }; } } });
  await assert.rejects(() => second.service.start({ filename: second.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot }), /plan.*changed/i);
  assert.equal(second.calls.sessions.length, 0);
});

test("reconciles a lost chunk response and retries from YouTube's authoritative offset", async (t) => {
  let attempts = 0; const sleeps = [];
  const transport = {
    async createSession() { return { sessionUrl: "https://upload.test/session" }; },
    async uploadChunk(values) { attempts += 1; if (attempts === 1) throw new Error("network lost"); return values.end + 1 === values.total ? { status: 201, completed: true, data: { id: "recovered" } } : { status: 308, range: `bytes=0-${values.end}` }; },
    async querySession() { return { status: 308, range: undefined }; },
  };
  const values = await fixture(t, { transport, sleep: async (ms) => sleeps.push(ms) }); const plan = await approvedPlan(values);
  await values.service.start({ filename: values.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot }); await values.service.waitForIdle();
  assert.equal(values.service.list()[0].status, "Completed"); assert.ok(attempts > 1); assert.deepEqual(sleeps, [250]);
});

test("restart marks active work interrupted and explicitly resumes a valid saved session", async (t) => {
  const values = await fixture(t); const plan = await approvedPlan(values); const details = await (await import("node:fs/promises")).stat(path.join(values.output, "compilation-videos", values.filename));
  await values.store.create({ id: "resume-me", sourceFilename: values.filename, sourceFingerprint: plan.source.fingerprint, sourceSize: plan.source.size, sourceMtimeMs: details.mtimeMs, sourceDuration: plan.source.duration, title: plan.title, description: plan.description, tags: plan.tags, visibility: "private", channelId: plan.channel.id, channelName: plan.channel.name, status: "Uploading", uploadedBytes: 4, sessionUrl: "https://upload.test/saved", createdAt: "2026-11-03T11:00:00Z", updatedAt: "2026-11-03T11:00:00Z" });
  const restartedStore = new YouTubeUploadStore(values.output, "oauth-client-secret");
  const transport = { async createSession() { assert.fail("must not create replacement session"); }, async querySession() { return { status: 308, range: "bytes=0-3" }; }, async uploadChunk(args) { return args.end + 1 === args.total ? { status: 201, completed: true, data: { id: "resumed" } } : { status: 308, range: `bytes=0-${args.end}` }; } };
  const restarted = new YouTubeUploadService(values.output, values.connection, restartedStore, { transport, chunkSize: 4, probe: async () => ({ duration: 3640.15, streams: [{ codecType: "video" }, { codecType: "audio" }] }), now: () => new Date("2026-11-03T12:00:00Z"), sleep: async () => {} });
  await restarted.initialize(); assert.equal(restarted.list()[0].status, "Interrupted"); await restarted.resume("resume-me"); await restarted.waitForIdle(); assert.equal(restarted.list()[0].youtubeVideoId, "resumed");
});

test("expired and ambiguous sessions stop without automatically creating replacements", async (t) => {
  const expired = await fixture(t); const plan = await approvedPlan(expired); const details = await (await import("node:fs/promises")).stat(path.join(expired.output, "compilation-videos", expired.filename));
  await expired.store.create({ id: "expired", sourceFilename: expired.filename, sourceFingerprint: plan.source.fingerprint, sourceSize: plan.source.size, sourceMtimeMs: details.mtimeMs, sourceDuration: plan.source.duration, title: plan.title, description: "", tags: [], visibility: "private", channelId: plan.channel.id, status: "Interrupted", uploadedBytes: 0, sessionUrl: "https://upload.test/expired", createdAt: "2026-11-03T11:00:00Z", updatedAt: "2026-11-03T11:00:00Z" });
  expired.transport.querySession = async () => ({ status: 404 }); await expired.service.resume("expired"); await expired.service.waitForIdle(); assert.equal(expired.service.list()[0].status, "SessionExpired"); assert.equal(expired.calls.sessions.length, 0);

  const uncertainTransport = { async createSession() { return { sessionUrl: "https://upload.test/uncertain" }; }, async uploadChunk() { throw new Error("response lost"); }, async querySession() { throw new Error("network unavailable"); } };
  const uncertain = await fixture(t, { transport: uncertainTransport }); const uncertainPlan = await approvedPlan(uncertain); await uncertain.service.start({ filename: uncertain.filename, title: uncertainPlan.title, description: uncertainPlan.description, tags: uncertainPlan.tags, snapshot: uncertainPlan.snapshot }); await uncertain.service.waitForIdle();
  assert.equal(uncertain.service.list()[0].status, "OutcomeUncertain"); assert.equal(uncertain.service.list()[0].canResume, true); await assert.rejects(() => approvedPlan(uncertain), /uncertain outcome/);
});

test("persistence failure while recording a runner failure blocks every further upload in memory", async (t) => {
  let failUpdates = false;
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-safety-block-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output"); const sourceDirectory = path.join(output, "compilation-videos");
  await mkdir(sourceDirectory, { recursive: true }); await writeFile(path.join(sourceDirectory, "one.mp4"), "0123456789"); await writeFile(path.join(sourceDirectory, "two.mp4"), "abcdefghij");
  const store = new YouTubeUploadStore(output, "oauth-client-secret"); await store.initialize();
  const originalUpdate = store.update.bind(store); store.update = async (...args) => { if (failUpdates) throw new Error("disk unavailable"); return originalUpdate(...args); };
  const service = new YouTubeUploadService(output, { async getVerifiedUploadContext() { return { channel: { id: "UC-safe", name: "Safe" }, getAccessToken: async () => "token" }; } }, store, {
    probe: async () => ({ duration: 60, streams: [{ codecType: "video" }, { codecType: "audio" }] }), chunkSize: 4,
    transport: { async createSession() { return { sessionUrl: "https://upload.test/session" }; }, async uploadChunk() { throw new Error("network failure"); }, async querySession() { throw new Error("network failure"); } }, sleep: async () => {},
  });
  const plan = await service.plan({ filename: "one.mp4", title: "One" });
  await service.start({ filename: "one.mp4", title: "One", snapshot: plan.snapshot }); failUpdates = true; await service.waitForIdle();
  assert.equal(service.status().blocked, true); assert.match(service.status().message, /manual investigation/i);
  await assert.rejects(() => service.plan({ filename: "two.mp4", title: "Two" }), /blocked.*manual investigation/i);
});

test("duplicate source/channel uploads and overlapping starts are rejected", async (t) => {
  let release; const hold = new Promise((resolve) => { release = resolve; });
  const transport = { async createSession() { await hold; return { sessionUrl: "https://upload.test/held" }; }, async uploadChunk(args) { return { status: 201, completed: true, data: { id: "one" } }; }, async querySession() { return { status: 308 }; } };
  const values = await fixture(t, { transport }); const plan = await approvedPlan(values); await values.service.start({ filename: values.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot });
  await assert.rejects(() => values.service.start({ filename: values.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot }), /already active/);
  release(); await values.service.waitForIdle(); await assert.rejects(() => approvedPlan(values), /already has upload record/);
});

test("simultaneous starts atomically admit only one resumable upload session", async (t) => {
  let releaseSession; const sessionHold = new Promise((resolve) => { releaseSession = resolve; });
  let markSessionStarted; const sessionStarted = new Promise((resolve) => { markSessionStarted = resolve; });
  let sessionCount = 0;
  const transport = {
    async createSession() { sessionCount += 1; markSessionStarted(); await sessionHold; return { sessionUrl: "https://upload.test/atomic" }; },
    async uploadChunk() { return { status: 201, completed: true, data: { id: "atomic-one" } }; },
    async querySession() { return { status: 308 }; },
  };
  const values = await fixture(t, { transport }); const plan = await approvedPlan(values);
  const input = { filename: values.filename, title: plan.title, description: plan.description, tags: plan.tags, snapshot: plan.snapshot };
  const results = await Promise.allSettled([values.service.start(input), values.service.start(input)]);
  await sessionStarted;
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /already active/);
  assert.equal(values.service.list().length, 1); assert.equal(sessionCount, 1);
  releaseSession(); await values.service.waitForIdle(); assert.equal(sessionCount, 1);
});

test("record persistence failure does not mutate authoritative in-memory state", async (t) => {
  let fail = false;
  const store = new YouTubeUploadStore(path.join(await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-store-fail-")), "output"), "oauth-client-secret", {
    async writeFile(...args) { if (fail) throw new Error("disk full"); return writeFile(...args); },
  });
  t.after(() => rm(path.dirname(store.outputDirectory), { recursive: true, force: true })); await store.initialize();
  const record = { id: "one", createdAt: "2026-01-01T00:00:00Z", status: "Starting" }; await store.create(record); fail = true;
  await assert.rejects(() => store.update("one", { status: "Uploading" }), /disk full/); assert.equal(store.get("one").status, "Starting");
});
