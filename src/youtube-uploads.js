import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { COMPILATION_VIDEOS_DIRECTORY } from "./compilation-video.js";
import { probeMedia, SpawnProcessRunner } from "./video.js";

const RECORDS_FILENAME = "youtube-upload-records.enc";
const CHUNK_SIZE = 8 * 1024 * 1024;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

export class YouTubeUploadStore {
  constructor(outputDirectory, secret, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory); this.filePath = path.join(this.outputDirectory, RECORDS_FILENAME); this.secret = secret;
    this.fs = { mkdir: dependencies.mkdir ?? mkdir, readFile: dependencies.readFile ?? readFile, rename: dependencies.rename ?? rename, rm: dependencies.rm ?? rm, writeFile: dependencies.writeFile ?? writeFile };
    this.randomBytes = dependencies.randomBytes ?? crypto.randomBytes; this.records = []; this.queue = Promise.resolve();
  }
  async initialize() {
    await this.fs.mkdir(this.outputDirectory, { recursive: true });
    try { this.records = decryptJson(await this.fs.readFile(this.filePath, "utf8"), this.#secret()); }
    catch (error) { if (error?.code !== "ENOENT") throw new UploadPersistenceError("YouTube upload records could not be decrypted. Uploads are blocked until the local configuration is repaired."); }
    let changed = false;
    for (const record of this.records) {
      if (["Starting", "Uploading"].includes(record.status)) { record.status = record.sessionUrl ? "Interrupted" : "OutcomeUncertain"; record.message = record.sessionUrl ? "Upload was interrupted. Explicitly resume the saved session after verifying the source and channel." : "The application stopped while creating an upload session. The outcome is uncertain; do not start another upload without manual reconciliation."; changed = true; }
      else if (record.status === "Finalizing") { record.status = "OutcomeUncertain"; record.message = "The application stopped while YouTube completion was uncertain. Reconcile this record before any new upload."; changed = true; }
    }
    if (changed) await this.#persist();
    return this.list();
  }
  list() { return structuredClone(this.records).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  get(id) { const record = this.records.find((item) => item.id === id); if (!record) throw new UploadNotFoundError("Upload record not found."); return structuredClone(record); }
  async create(record) { return this.#exclusive(async () => { const next = structuredClone(this.records); next.push(structuredClone(record)); await this.#persist(next); this.records = next; return this.get(record.id); }); }
  async update(id, values) { return this.#exclusive(async () => { const next = structuredClone(this.records); const record = next.find((item) => item.id === id); if (!record) throw new UploadNotFoundError("Upload record not found."); Object.assign(record, structuredClone(values)); await this.#persist(next); this.records = next; return this.get(id); }); }
  async #persist(records = this.records) {
    const temporary = path.join(this.outputDirectory, `.youtube-uploads-${this.randomBytes(8).toString("hex")}.tmp`);
    try { await this.fs.writeFile(temporary, encryptJson(records, this.#secret(), this.randomBytes), { encoding: "utf8", flag: "wx", mode: 0o600 }); await this.fs.rename(temporary, this.filePath); }
    catch (error) { await this.fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  #exclusive(operation) { const result = this.queue.then(operation, operation); this.queue = result.catch(() => {}); return result; }
  #secret() { if (typeof this.secret !== "string" || this.secret.length < 8) throw new UploadPersistenceError("YouTube OAuth client secret is required to protect upload records."); return this.secret; }
}

export class YouTubeUploadService {
  constructor(outputDirectory, youtubeConnection, store, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory); this.sourceDirectory = path.join(this.outputDirectory, COMPILATION_VIDEOS_DIRECTORY);
    this.youtubeConnection = youtubeConnection; this.store = store;
    this.runner = dependencies.runner ?? new SpawnProcessRunner(); this.ffprobe = dependencies.ffprobe ?? "ffprobe";
    this.probe = dependencies.probe ?? ((filePath) => probeMedia(this.runner, this.ffprobe, filePath));
    this.transport = dependencies.transport ?? new YouTubeResumableTransport(); this.chunkSize = dependencies.chunkSize ?? CHUNK_SIZE;
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID; this.now = dependencies.now ?? (() => new Date()); this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fs = { mkdir: dependencies.mkdir ?? mkdir, open: dependencies.open ?? open, readdir: dependencies.readdir ?? readdir, realpath: dependencies.realpath ?? realpath, stat: dependencies.stat ?? stat };
    this.activeId = undefined; this.runningPromise = undefined; this.safetyBlock = undefined; this.admissionQueue = Promise.resolve();
  }
  async initialize() { await this.fs.mkdir(this.sourceDirectory, { recursive: true }); await this.store.initialize(); return this.list(); }
  list() { return this.store.list().map(publicRecord); }
  status() { return { active: Boolean(this.activeId), activeId: this.activeId, blocked: Boolean(this.safetyBlock), message: this.safetyBlock }; }
  async listSources() {
    const items = [];
    for (const entry of await this.fs.readdir(this.sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !safeFilename(entry.name)) continue;
      const details = await this.fs.stat(this.#sourcePath(entry.name)); if (details.size > 0) items.push({ filename: entry.name, size: details.size });
    }
    return items.sort((a, b) => a.filename.localeCompare(b.filename));
  }
  async plan(input) {
    if (this.safetyBlock) throw new UploadConflictError(this.safetyBlock);
    const metadata = validateMetadata(input); const source = await this.#inspectSource(input.filename);
    const context = await this.youtubeConnection.getVerifiedUploadContext();
    if (this.store.list().some((record) => record.status === "OutcomeUncertain")) throw new UploadConflictError("An earlier upload has an uncertain outcome. Reconcile it manually before creating any new YouTube upload session.");
    const duplicate = this.store.list().find((record) => record.sourceFingerprint === source.fingerprint && record.channelId === context.channel.id && record.status !== "SessionExpired");
    if (duplicate) throw new UploadConflictError(`This source already has upload record ${duplicate.id} for the verified channel. A separate duplicate-upload workflow is required.`);
    const plan = { source: { filename: input.filename, size: source.size, duration: source.duration, fingerprint: source.fingerprint }, title: metadata.title, description: metadata.description, tags: metadata.tags, visibility: "private", channel: context.channel };
    return { ...plan, snapshot: approvalSnapshot(plan) };
  }
  async start(input) {
    return this.#admit(async () => {
      if (this.activeId) throw new UploadConflictError("Another YouTube upload is already active.");
      const plan = await this.plan(input);
      if (plan.snapshot !== input.snapshot) throw new UploadConflictError("The upload plan, source file, or verified channel changed. Review and approve a new plan.");
      const now = this.now().toISOString();
      const sourceDetails = await this.fs.stat(this.#sourcePath(plan.source.filename));
      const record = await this.store.create({ id: this.randomUUID(), sourceFilename: plan.source.filename, sourceFingerprint: plan.source.fingerprint, sourceSize: plan.source.size, sourceMtimeMs: sourceDetails.mtimeMs, sourceDuration: plan.source.duration, title: plan.title, description: plan.description, tags: plan.tags, visibility: "private", channelId: plan.channel.id, channelName: plan.channel.name, status: "Starting", uploadedBytes: 0, sessionUrl: undefined, youtubeVideoId: undefined, youtubeVideoUrl: undefined, createdAt: now, updatedAt: now, message: "Creating a private resumable YouTube upload session." });
      this.#launch(record.id, false);
      return publicRecord(record);
    });
  }
  async resume(id) {
    return this.#admit(async () => {
      if (this.activeId) throw new UploadConflictError("Another YouTube upload is already active.");
      const record = this.store.get(id);
      if (!record.sessionUrl || !["Interrupted", "Failed", "OutcomeUncertain"].includes(record.status)) throw new UploadConflictError("This record does not have a resumable session. No new session was created.");
      await this.#assertRecordSource(record); const context = await this.youtubeConnection.getVerifiedUploadContext();
      if (context.channel.id !== record.channelId) throw new UploadConflictError("The verified YouTube channel no longer matches this upload record.");
      const updated = await this.store.update(id, { status: "Uploading", message: "Checking the existing YouTube session before resuming.", updatedAt: this.now().toISOString() });
      this.#launch(id, true); return publicRecord(updated);
    });
  }
  waitForIdle() { return this.runningPromise ?? Promise.resolve(); }
  #admit(operation) { const result = this.admissionQueue.then(operation, operation); this.admissionQueue = result.then(() => undefined, () => undefined); return result; }
  #launch(id, resume) {
    this.activeId = id;
    this.runningPromise = this.#run(id, resume).catch(async (error) => {
      const current = this.store.get(id);
      if (!["SessionExpired", "OutcomeUncertain"].includes(current.status)) {
        try { await this.store.update(id, { status: error instanceof UploadOutcomeUncertainError ? "OutcomeUncertain" : "Failed", message: error.message, updatedAt: this.now().toISOString() }); }
        catch {
          this.safetyBlock = "YouTube upload state could not be persisted after a failure. All further uploads are blocked for this server session. Restart only after reviewing the encrypted upload records and YouTube Studio; manual investigation is required.";
        }
      }
    }).finally(() => { this.activeId = undefined; this.runningPromise = undefined; });
  }
  async #run(id, resume) {
    let record = this.store.get(id); const source = await this.#assertRecordSource(record); const context = await this.youtubeConnection.getVerifiedUploadContext();
    if (context.channel.id !== record.channelId) throw new UploadConflictError("The verified YouTube channel changed after approval. Upload stopped.");
    if (!resume) {
      let session;
      try { session = await this.transport.createSession({ token: await context.getAccessToken(), size: record.sourceSize, metadata: { snippet: { title: record.title, description: record.description, tags: record.tags, categoryId: "10" }, status: { privacyStatus: "private" } } }); }
      catch { throw new UploadOutcomeUncertainError("The resumable session response was lost or failed. No replacement session was created; manual reconciliation is required."); }
      if (!session?.sessionUrl) throw new UploadOutcomeUncertainError("YouTube did not return a resumable session URL. No replacement session was created.");
      try { record = await this.store.update(id, { sessionUrl: session.sessionUrl, status: "Uploading", message: "Private upload session created.", updatedAt: this.now().toISOString() }); }
      catch { throw new UploadOutcomeUncertainError("A YouTube session was created but its sensitive session state could not be persisted. Do not start another upload; manual reconciliation is required."); }
    }
    let offset = record.uploadedBytes ?? 0;
    if (resume) {
      const status = await this.#queryWithRetry(record, context);
      if (status.completed) { await this.#complete(id, status.data); return; }
      if (status.expired) { await this.store.update(id, { status: "SessionExpired", message: "The saved YouTube session expired. No new session was started. Review the channel and source before explicitly planning another upload.", updatedAt: this.now().toISOString() }); return; }
      offset = status.offset;
    }
    const handle = await this.fs.open(source.path, "r");
    try {
      let retriesAtOffset = 0;
      while (offset < record.sourceSize) {
        await this.#assertSourceUnchanged(record);
        const length = Math.min(this.chunkSize, record.sourceSize - offset); const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset); if (bytesRead !== length) throw new UploadSourceError("The source MP4 changed or became unreadable during upload.");
        let response; let recovered = false;
        try { response = await this.transport.uploadChunk({ sessionUrl: record.sessionUrl, token: await context.getAccessToken(), start: offset, end: offset + length - 1, total: record.sourceSize, body: buffer }); }
        catch { recovered = true; response = await this.#queryWithRetry(record, context); }
        if (response.completed) { await this.#complete(id, response.data); return; }
        if (response.status === 308) response = { offset: rangeOffset(response.range) };
        else if (response.status === 404) response = { expired: true };
        else if (RETRYABLE.has(response.status)) { recovered = true; response = await this.#queryWithRetry(record, context); }
        else if (!Number.isInteger(response.offset)) throw new UploadOutcomeUncertainError(`YouTube chunk upload returned HTTP ${response.status ?? "unknown"}. Manual reconciliation is required.`);
        if (response.completed) { await this.#complete(id, response.data); return; }
        if (response.expired) { await this.store.update(id, { status: "SessionExpired", message: "The resumable YouTube session expired. No new session was started.", updatedAt: this.now().toISOString() }); return; }
        if (!Number.isInteger(response.offset) || response.offset < offset || response.offset > record.sourceSize) throw new UploadOutcomeUncertainError("YouTube returned an invalid resumable offset. Manual reconciliation is required.");
        if (recovered && response.offset === offset) {
          retriesAtOffset += 1;
          if (retriesAtOffset > MAX_RETRIES) throw new UploadTransientError("YouTube did not accept this chunk after bounded retries. The saved session can be resumed explicitly later.");
          await this.sleep(250 * 2 ** (retriesAtOffset - 1));
        } else retriesAtOffset = 0;
        offset = response.offset;
        record = await this.store.update(id, { status: "Uploading", uploadedBytes: offset, message: `Uploaded ${offset} of ${record.sourceSize} bytes.`, updatedAt: this.now().toISOString() });
      }
      await this.store.update(id, { status: "Finalizing", message: "All bytes were sent; checking YouTube for the final video ID.", updatedAt: this.now().toISOString() });
      const finalStatus = await this.#queryWithRetry(record, context);
      if (finalStatus.completed) await this.#complete(id, finalStatus.data);
      else throw new UploadOutcomeUncertainError("All bytes were sent but YouTube did not return a final video ID. Manual reconciliation is required before another upload.");
    } finally { await handle.close(); }
  }
  async #queryWithRetry(record, context) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const result = await this.transport.querySession({ sessionUrl: record.sessionUrl, token: await context.getAccessToken(), total: record.sourceSize });
        if (result.status === 404) return { expired: true };
        if (result.completed) return result;
        if (result.status === 308) return { offset: rangeOffset(result.range) };
        if (!RETRYABLE.has(result.status)) throw new UploadOutcomeUncertainError(`YouTube session status returned HTTP ${result.status}. Manual reconciliation is required.`);
      } catch (error) { if (error instanceof UploadOutcomeUncertainError) throw error; if (attempt === MAX_RETRIES) throw new UploadOutcomeUncertainError("The saved YouTube session could not be reconciled after bounded retries. Manual investigation is required."); }
      await this.sleep(250 * 2 ** attempt);
    }
  }
  async #complete(id, data) {
    if (!data?.id) throw new UploadOutcomeUncertainError("YouTube reported completion without a video ID. Manual reconciliation is required.");
    try { await this.store.update(id, { status: "Completed", uploadedBytes: this.store.get(id).sourceSize, youtubeVideoId: data.id, youtubeVideoUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(data.id)}`, sessionUrl: undefined, message: "Private upload completed. Review it manually in YouTube Studio.", completedAt: this.now().toISOString(), updatedAt: this.now().toISOString() }); }
    catch { throw new UploadOutcomeUncertainError(`YouTube returned completed video ID ${data.id}, but local completion could not be persisted. Do not upload again; inspect this video in YouTube Studio.`); }
  }
  async #inspectSource(filename) {
    const filePath = this.#sourcePath(filename); const details = await assertFile(this.fs.stat, filePath);
    const [realSourceDirectory, realFilePath] = await Promise.all([this.fs.realpath(this.sourceDirectory), this.fs.realpath(filePath)]);
    if (path.dirname(realFilePath) !== realSourceDirectory) throw new UploadSourceError("The selected compilation MP4 must be a file inside the compilation-videos directory.");
    const media = await this.probe(filePath);
    const video = media.streams?.find((item) => item.codecType === "video"); const audio = media.streams?.find((item) => item.codecType === "audio"); const duration = media.duration ?? video?.duration;
    if (!video || !audio || !Number.isFinite(duration) || duration <= 0) throw new UploadSourceError("The selected compilation MP4 is not valid completed video media.");
    return { path: filePath, size: details.size, mtimeMs: details.mtimeMs, duration, fingerprint: await hashFile(filePath) };
  }
  async #assertRecordSource(record) { const source = await this.#inspectSource(record.sourceFilename); if (source.size !== record.sourceSize || source.fingerprint !== record.sourceFingerprint) throw new UploadSourceError("The source MP4 changed after approval. Upload stopped without creating a replacement session."); return source; }
  async #assertSourceUnchanged(record) { const details = await assertFile(this.fs.stat, this.#sourcePath(record.sourceFilename)); if (details.size !== record.sourceSize || details.mtimeMs !== record.sourceMtimeMs) throw new UploadSourceError("The source MP4 changed during upload. Upload stopped without creating a replacement session."); }
  #sourcePath(filename) { if (!safeFilename(filename)) throw new UploadSourceError("Invalid compilation MP4 filename."); const resolved = path.resolve(this.sourceDirectory, filename); if (path.dirname(resolved) !== this.sourceDirectory) throw new UploadSourceError("Source path escaped the compilation-videos directory."); return resolved; }
}

export class YouTubeResumableTransport {
  constructor(fetchFn = fetch) { this.fetch = fetchFn; }
  async createSession({ token, size, metadata }) {
    const response = await this.fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": "video/mp4" }, body: JSON.stringify(metadata), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Session creation failed with HTTP ${response.status}.`); return { sessionUrl: response.headers.get("location") };
  }
  async uploadChunk({ sessionUrl, token, start, end, total, body }) {
    const response = await this.fetch(sessionUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "video/mp4", "Content-Length": String(body.length), "Content-Range": `bytes ${start}-${end}/${total}` }, body, signal: AbortSignal.timeout(120_000) });
    return parseResponse(response);
  }
  async querySession({ sessionUrl, token, total }) {
    const response = await this.fetch(sessionUrl, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Length": "0", "Content-Range": `bytes */${total}` }, signal: AbortSignal.timeout(120_000) });
    return parseResponse(response);
  }
}

async function parseResponse(response) { const data = [200, 201].includes(response.status) ? await response.json().catch(() => undefined) : undefined; return { status: response.status, completed: [200, 201].includes(response.status), range: response.headers.get("range"), data }; }
function rangeOffset(range) { if (!range) return 0; const match = /(?:bytes=)?0-(\d+)/.exec(range); if (!match) throw new UploadOutcomeUncertainError("YouTube returned an invalid resumable Range header."); return Number(match[1]) + 1; }
function validateMetadata(input) { const title = String(input?.title ?? "").trim(); const description = String(input?.description ?? "").trim(); if (!title || title.length > 100) throw new UploadValidationError("Video title must contain 1–100 characters."); if (description.length > 5000) throw new UploadValidationError("Description must not exceed 5,000 characters."); const tags = Array.isArray(input?.tags) ? input.tags : String(input?.tags ?? "").split(","); const normalized = tags.map((tag) => String(tag).trim()).filter(Boolean); if (normalized.join(",").length > 500) throw new UploadValidationError("Combined tags must not exceed 500 characters."); return { title, description, tags: [...new Set(normalized)] }; }
function approvalSnapshot(plan) { return crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex"); }
function safeFilename(filename) { return typeof filename === "string" && filename.length <= 180 && path.basename(filename) === filename && path.extname(filename).toLowerCase() === ".mp4" && !filename.startsWith(".") && !/[<>:"/\\|?*\x00-\x1f]/.test(filename); }
async function assertFile(statFn, filePath) { try { const details = await statFn(filePath); if (!details.isFile?.() || details.size <= 0) throw new Error(); return details; } catch { throw new UploadSourceError("The selected compilation MP4 is missing or invalid."); } }
async function hashFile(filePath) { const hash = crypto.createHash("sha256"); await pipeline(createReadStream(filePath), new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } })); return hash.digest("hex"); }
function publicRecord(record) { const { sessionUrl, description, ...safe } = structuredClone(record); return { ...safe, canResume: Boolean(sessionUrl) && ["Interrupted", "Failed", "OutcomeUncertain"].includes(record.status), descriptionLength: description?.length ?? 0, progressPercent: record.sourceSize ? Math.min(100, (record.uploadedBytes / record.sourceSize) * 100) : 0 }; }
function encryptJson(value, secret, randomBytes) { const salt = randomBytes(16); const iv = randomBytes(12); const key = crypto.scryptSync(secret, salt, 32); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]); return `${JSON.stringify({ version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }, null, 2)}\n`; }
function decryptJson(envelopeText, secret) { const envelope = JSON.parse(envelopeText); const key = crypto.scryptSync(secret, Buffer.from(envelope.salt, "base64"), 32); const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64")); decipher.setAuthTag(Buffer.from(envelope.tag, "base64")); return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8")); }

export class UploadValidationError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class UploadSourceError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class UploadNotFoundError extends Error { constructor(message) { super(message); this.statusCode = 404; } }
export class UploadConflictError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class UploadOutcomeUncertainError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class UploadPersistenceError extends Error { constructor(message) { super(message); this.statusCode = 500; } }
export class UploadTransientError extends Error { constructor(message) { super(message); this.statusCode = 502; } }
