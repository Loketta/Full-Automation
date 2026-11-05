import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { COMPILATION_VIDEOS_DIRECTORY } from "./compilation-video.js";
import { probeMedia, SpawnProcessRunner } from "./video.js";

const THUMBNAILS_DIRECTORY = "youtube-thumbnails";
const MAX_THUMBNAIL_BYTES = 50 * 1024 * 1024;

export class YouTubeFinishingService {
  constructor(outputDirectory, connection, uploadStore, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory); this.sourceDirectory = path.join(this.outputDirectory, COMPILATION_VIDEOS_DIRECTORY); this.thumbnailDirectory = path.join(this.outputDirectory, THUMBNAILS_DIRECTORY);
    this.connection = connection; this.store = uploadStore; this.ffmpeg = dependencies.ffmpeg ?? "ffmpeg"; this.ffprobe = dependencies.ffprobe ?? "ffprobe"; this.runner = dependencies.runner ?? new SpawnProcessRunner(); this.probe = dependencies.probe ?? ((file) => probeMedia(this.runner, this.ffprobe, file)); this.fs = { mkdir: dependencies.mkdir ?? mkdir, rm: dependencies.rm ?? rm, stat: dependencies.stat ?? stat }; this.hashFile = dependencies.hashFile ?? streamHash; this.now = dependencies.now ?? (() => new Date()); this.activeThumbnailUpload = undefined; this.admissionQueue = Promise.resolve();
  }
  async initialize() { await this.fs.mkdir(this.thumbnailDirectory, { recursive: true }); return this.list(); }
  async discover() {
    for (const record of this.store.list().filter((item) => item.status === "Completed" && item.youtubeVideoId && !item.endScreen)) {
      if (record.uploadKind === "individual") await this.store.update(record.id, { endScreen: { status: "NotApplicable", message: "Individual-track upload." } });
      else { const previous = this.#previous(record); await this.store.update(record.id, { endScreen: previous ? { status: "Pending", sourceVideoId: previous.youtubeVideoId, sourceTitle: previous.title, sourceStudioUrl: studioUrl(previous.youtubeVideoId), warning: "Confirm that the suggested source actually has an end screen before importing it." } : { status: "NotApplicable", message: "No earlier completed compilation from this channel is available." } }); }
    }
    return this.list();
  }
  list() { return this.store.list().filter((record) => record.status === "Completed" && record.youtubeVideoId).map((record) => this.#public(record)); }
  get(id) { return this.#public(this.#record(id)); }
  async refreshDeclarations(id) {
    const record = this.#record(id); const context = await this.connection.getVerifiedReadContext(); this.#assertChannel(record, context.channel);
    const response = await context.youtube.videos.list({ part: ["status"], id: [record.youtubeVideoId], maxResults: 1 }); const video = response?.data?.items?.find((item) => item.id === record.youtubeVideoId);
    if (!video) throw new FinishingValidationError("YouTube did not return the exact completed video for declaration review.");
    const audience = declarationStatus(video.status?.selfDeclaredMadeForKids, false); const synthetic = declarationStatus(video.status?.containsSyntheticMedia, true);
    await this.store.update(record.id, { audienceStatus: audience, disclosureStatus: synthetic, readyForPublicRelease: isConfirmed(audience) && isConfirmed(synthetic), declarationsReviewedAt: this.now().toISOString() }); return this.get(id);
  }
  async confirmAudience(id) { const record = this.#record(id); return this.#update(id, { audienceStatus: "ManuallyConfirmed", audienceConfirmedAt: this.now().toISOString(), readyForPublicRelease: isConfirmed(record.disclosureStatus) }); }
  async confirmEndScreen(id) { const record = this.#record(id); if (record.uploadKind === "individual") throw new FinishingValidationError("Individual-track uploads do not require a compilation end screen."); const previous = record.endScreen?.sourceVideoId ? { youtubeVideoId: record.endScreen.sourceVideoId, title: record.endScreen.sourceTitle } : this.#previous(record); if (!previous) throw new FinishingValidationError("No previous completed compilation is available to import an end screen from."); return this.#update(id, { endScreen: { status: "Completed", sourceVideoId: previous.youtubeVideoId, sourceTitle: previous.title, confirmedAt: this.now().toISOString() } }); }
  async generateCandidates(id, customTimestamp) {
    const record = this.#record(id); const source = await this.#source(record); const media = await this.probe(source.path); const duration = Number(media.duration ?? media.streams?.find((item) => item.codecType === "video")?.duration);
    if (!Number.isFinite(duration) || duration <= 2) throw new FinishingValidationError("The original MP4 has no usable duration for thumbnail extraction.");
    const timestamps = customTimestamp === undefined ? deterministicThumbnailTimestamps(duration) : [validateCustomTimestamp(customTimestamp, duration)]; const directory = this.#recordDirectory(id); await this.fs.mkdir(directory, { recursive: true }); const candidates = customTimestamp === undefined ? [] : [...(record.thumbnailCandidates ?? [])];
    if (customTimestamp === undefined) await this.fs.rm(directory, { recursive: true, force: true }).then(() => this.fs.mkdir(directory, { recursive: true }));
    for (const timestamp of timestamps) { const key = `frame-${Math.round(timestamp * 1000)}`; const filename = `${key}.jpg`; const output = path.join(directory, filename); await this.runner.run(this.ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", timestamp.toFixed(3), "-i", source.path, "-frames:v", "1", "-q:v", "2", "-y", output]); const image = await this.#validateImage(output); const candidate = { id: key, filename, timestamp, width: image.width, height: image.height, size: image.size, sourceFingerprint: record.sourceFingerprint }; const existing = candidates.findIndex((item) => item.id === key); if (existing >= 0) candidates[existing] = candidate; else candidates.push(candidate); }
    return this.#update(id, { thumbnailCandidates: candidates, thumbnailState: { status: "Pending", selectedCandidateId: record.thumbnailState?.selectedCandidateId } });
  }
  async planThumbnail(id, candidateId) {
    const record = this.#record(id); const context = await this.connection.getVerifiedUploadContext(); this.#assertChannel(record, context.channel); await this.#source(record); const candidate = await this.#candidate(record, candidateId);
    const plan = { recordId: id, youtubeVideoId: record.youtubeVideoId, channelId: record.channelId, sourceFingerprint: record.sourceFingerprint, candidateId, timestamp: candidate.timestamp, thumbnailFingerprint: candidate.fingerprint, visibility: "private" }; return { ...plan, snapshot: snapshot(plan) };
  }
  async uploadThumbnail(input) {
    const plan = await this.#admit(async () => { if (this.activeThumbnailUpload) throw new FinishingConflictError("Another thumbnail upload is already active."); const approved = await this.planThumbnail(input.recordId, input.candidateId); if (approved.snapshot !== input.snapshot) throw new FinishingConflictError("The thumbnail plan, source video, candidate, or channel changed. Review it again."); this.activeThumbnailUpload = approved.recordId; return approved; });
    try { const record = this.#record(plan.recordId); const candidate = await this.#candidate(record, plan.candidateId); await this.store.update(record.id, { thumbnailState: { status: "Uploading", selectedCandidateId: plan.candidateId, timestamp: plan.timestamp, sourceFingerprint: plan.sourceFingerprint, updatedAt: this.now().toISOString() } }); const context = await this.connection.getVerifiedUploadContext(); this.#assertChannel(record, context.channel); const response = await context.youtube.thumbnails.set({ videoId: record.youtubeVideoId, media: { mimeType: "image/jpeg", body: createReadStream(candidate.path) } }); if (!response?.data?.items?.length) throw new FinishingExternalError("YouTube accepted the request without returning thumbnail metadata. Verify the private video in Studio before retrying."); return this.#update(record.id, { thumbnailState: { status: "Completed", selectedCandidateId: plan.candidateId, timestamp: plan.timestamp, sourceFingerprint: plan.sourceFingerprint, completedAt: this.now().toISOString(), message: "YouTube accepted the custom thumbnail. CDN visibility may take time." } }); }
    catch (error) { await this.store.update(plan.recordId, { thumbnailState: { status: "Failed", selectedCandidateId: plan.candidateId, timestamp: plan.timestamp, sourceFingerprint: plan.sourceFingerprint, failedAt: this.now().toISOString(), message: thumbnailError(error) } }).catch(() => {}); throw error instanceof FinishingError ? error : new FinishingExternalError(thumbnailError(error)); }
    finally { this.activeThumbnailUpload = undefined; }
  }
  async candidateFile(id, candidateId) { const candidate = await this.#candidate(this.#record(id), candidateId); return candidate.path; }
  #record(id) { const record = this.store.get(id); if (record.status !== "Completed" || !record.youtubeVideoId) throw new FinishingValidationError("Select a completed YouTube upload record."); return record; }
  #public(record) { const previous = record.uploadKind === "individual" ? undefined : this.#previous(record); const endScreen = record.uploadKind === "individual" ? { status: "NotApplicable", message: "Individual-track upload." } : record.endScreen ?? (previous ? { status: "Pending", sourceVideoId: previous.youtubeVideoId, sourceTitle: previous.title, sourceStudioUrl: studioUrl(previous.youtubeVideoId), warning: "Confirm that the suggested source actually has an end screen before importing it." } : { status: "NotApplicable", message: "No earlier completed compilation from this channel is available." }); return { ...publicRecord(record), previousCompilation: previous ? { videoId: previous.youtubeVideoId, title: previous.title, studioUrl: studioUrl(previous.youtubeVideoId) } : undefined, endScreen, candidates: (record.thumbnailCandidates ?? []).map((item) => ({ ...item, previewUrl: `/api/youtube/finishing/${encodeURIComponent(record.id)}/candidates/${encodeURIComponent(item.id)}` })) }; }
  #previous(record) { return this.store.list().filter((item) => item.id !== record.id && item.channelId === record.channelId && item.status === "Completed" && item.youtubeVideoId && item.uploadKind !== "individual" && item.createdAt < record.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; }
  async #source(record) { if (path.basename(record.sourceFilename) !== record.sourceFilename) throw new FinishingValidationError("The stored source filename is unsafe."); const sourcePath = path.join(this.sourceDirectory, record.sourceFilename); const details = await this.fs.stat(sourcePath).catch(() => undefined); if (!details?.isFile?.() || details.size !== record.sourceSize) throw new FinishingValidationError("The original local MP4 is missing or changed. Thumbnail extraction is blocked; do not re-upload the video."); const fingerprint = await this.hashFile(sourcePath); if (fingerprint !== record.sourceFingerprint) throw new FinishingValidationError("The original local MP4 fingerprint no longer matches the completed upload record. Thumbnail extraction is blocked."); return { path: sourcePath }; }
  async #candidate(record, id) { if (!safeId(id)) throw new FinishingValidationError("Invalid thumbnail candidate."); const candidate = (record.thumbnailCandidates ?? []).find((item) => item.id === id); if (!candidate || candidate.sourceFingerprint !== record.sourceFingerprint) throw new FinishingValidationError("The selected thumbnail candidate is missing or stale."); const filePath = path.join(this.#recordDirectory(record.id), candidate.filename); const validated = await this.#validateImage(filePath); return { ...candidate, path: filePath, fingerprint: await this.hashFile(filePath), ...validated }; }
  async #validateImage(filePath) { const details = await this.fs.stat(filePath).catch(() => undefined); if (!details?.isFile?.() || details.size <= 0 || details.size > MAX_THUMBNAIL_BYTES) throw new FinishingValidationError("Thumbnail must be a non-empty JPEG no larger than 50 MB."); const media = await this.probe(filePath); const video = media.streams?.find((item) => item.codecType === "video"); if (!video?.width || !video?.height || !["mjpeg", "jpeg"].includes(video.codecName)) throw new FinishingValidationError("FFmpeg did not produce a valid JPEG thumbnail."); return { width: video.width, height: video.height, size: details.size }; }
  #recordDirectory(id) { if (!safeId(id)) throw new FinishingValidationError("Invalid upload record ID."); return path.join(this.thumbnailDirectory, id); }
  #assertChannel(record, channel) { if (record.channelId !== channel.id) throw new FinishingConflictError("The verified YouTube channel does not match this completed upload record."); }
  async #update(id, values) { await this.store.update(id, values); return this.get(id); }
  #admit(operation) { const result = this.admissionQueue.then(operation, operation); this.admissionQueue = result.then(() => undefined, () => undefined); return result; }
}

export function deterministicThumbnailTimestamps(duration) { const margin = Math.min(5, duration * 0.1); const span = duration - 2 * margin; if (span <= 0) throw new FinishingValidationError("Video is too short for safe thumbnail sampling."); return Array.from({ length: 6 }, (_, index) => Number((margin + span * ((index + 1) / 7)).toFixed(3))); }
export function validateCustomTimestamp(value, duration) { const number = Number(value); const margin = Math.min(5, duration * 0.1); if (!Number.isFinite(number) || number < margin || number > duration - margin) throw new FinishingValidationError(`Thumbnail timestamp must be between ${margin.toFixed(1)} and ${(duration - margin).toFixed(1)} seconds.`); return Number(number.toFixed(3)); }
function declarationStatus(value, expected) { return value === expected ? "Verified" : value === undefined ? "SubmittedUnverified" : "Mismatch"; }
function isConfirmed(value) { return ["Verified", "ManuallyConfirmed"].includes(value); }
function safeId(value) { return typeof value === "string" && /^[A-Za-z0-9-]{1,100}$/.test(value); }
function studioUrl(id) { return `https://studio.youtube.com/video/${encodeURIComponent(id)}/edit`; }
function snapshot(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
async function streamHash(filePath) { const digest = crypto.createHash("sha256"); for await (const chunk of createReadStream(filePath)) digest.update(chunk); return digest.digest("hex"); }
function publicRecord(record) { const { sessionUrl, description, ...safe } = structuredClone(record); return safe; }
function thumbnailError(error) { const status = Number(error?.code ?? error?.response?.status); if (status === 403) return "YouTube rejected the thumbnail. Verify channel ownership and custom-thumbnail eligibility in YouTube Studio."; if (status === 429) return "YouTube's thumbnail upload rate limit was reached. Retry this saved candidate later."; return `Thumbnail upload failed: ${error?.message ?? "unknown error"}`; }
class FinishingError extends Error { constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; } }
export class FinishingValidationError extends FinishingError {}
export class FinishingConflictError extends FinishingError { constructor(message) { super(message, 409); } }
export class FinishingExternalError extends FinishingError { constructor(message) { super(message, 502); } }
