import crypto from "node:crypto";
import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { buildMixTimeline, MIXES_DIRECTORY, MINIMUM_MIX_DURATION_SECONDS } from "./mixes.js";
import { probeMedia, SpawnProcessRunner, VISUAL_ASSETS_DIRECTORY } from "./video.js";

export const COMPILATION_VIDEOS_DIRECTORY = "compilation-videos";
const WIDTH = 1920;
const HEIGHT = 1080;
const PROVENANCE_FILENAME = "compilation-video-exports.json";

export class CompilationVideoService {
  constructor(outputDirectory, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.mixesDirectory = path.join(this.outputDirectory, MIXES_DIRECTORY);
    this.assetsDirectory = path.join(this.outputDirectory, VISUAL_ASSETS_DIRECTORY);
    this.exportsDirectory = path.join(this.outputDirectory, COMPILATION_VIDEOS_DIRECTORY);
    this.ffmpeg = dependencies.ffmpeg ?? "ffmpeg";
    this.ffprobe = dependencies.ffprobe ?? "ffprobe";
    this.runner = dependencies.runner ?? new SpawnProcessRunner();
    this.probe = dependencies.probe ?? ((filePath) => probeMedia(this.runner, this.ffprobe, filePath));
    this.minimumSourceDuration = dependencies.minimumSourceDuration ?? MINIMUM_MIX_DURATION_SECONDS;
    this.toleranceSeconds = dependencies.toleranceSeconds ?? 1.5;
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.mixStore = dependencies.mixStore;
    this.mixService = dependencies.mixService;
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir, readFile: dependencies.readFile ?? readFile, readdir: dependencies.readdir ?? readdir,
      rm: dependencies.rm ?? rm, stat: dependencies.stat ?? stat,
      writeFile: dependencies.writeFile ?? writeFile, rename: dependencies.rename ?? rename,
      publish: dependencies.publish ?? ((source, destination) => rename(source, destination)),
      realpath: dependencies.realpath ?? realpath,
    };
    this.available = false;
    this.error = undefined;
    this.active = false;
    this.provenancePath = path.join(this.outputDirectory, PROVENANCE_FILENAME);
    this.provenance = [];
  }

  async initialize() {
    await Promise.all([
      this.fs.mkdir(this.mixesDirectory, { recursive: true }),
      this.fs.mkdir(this.assetsDirectory, { recursive: true }),
      this.fs.mkdir(this.exportsDirectory, { recursive: true }),
    ]);
    for (const entry of await this.fs.readdir(this.exportsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^\.rendering-[a-zA-Z0-9-]+\.mp4$/.test(entry.name)) {
        await this.fs.rm(path.join(this.exportsDirectory, entry.name), { force: true });
      }
    }
    try { const stored = JSON.parse(await this.fs.readFile(this.provenancePath, "utf8")); if (stored?.version !== 1 || !Array.isArray(stored.exports)) throw new Error("Unsupported provenance format."); this.provenance = stored.exports; }
    catch (error) { if (error?.code !== "ENOENT") throw new CompilationRenderError(`Compilation provenance could not be loaded: ${error.message}`); }
    try {
      await this.runner.check(this.ffmpeg);
      await this.runner.check(this.ffprobe);
      this.available = true;
      this.error = undefined;
    } catch (error) {
      this.available = false;
      this.error = `FFmpeg/FFprobe is unavailable. Configure FFMPEG_PATH and FFPROBE_PATH, then restart. ${error.message}`;
    }
    return this.status();
  }

  status() { return { available: this.available, error: this.error, active: this.active }; }
  getExportProvenance(filename) { const record = this.provenance.find((item) => item.filename === filename); return record ? structuredClone(record) : undefined; }
  diagnoseMasterProvenance(filename) {
    if (!this.mixStore) return { status: "incomplete", verified: false, message: "Mix storage is unavailable, so automatic chapter provenance cannot be recorded." };
    const matches = this.mixStore.list().flatMap((mix) => (mix.exports ?? []).filter((item) => item.filename === filename).map((item) => ({ mixId: mix.id, snapshot: item.snapshot, timeline: item.timeline })));
    if (!matches.length) return { status: "missing", verified: false, message: "No saved WAV export record matches this master. The MP4 can be rendered, but automatic chapters will be unavailable." };
    if (matches.length > 1) return { status: "ambiguous", verified: false, message: `${matches.length} saved WAV export records use this filename. Selective recovery is required before chapters can be trusted.` };
    const match = matches[0]; if (!match.snapshot) return { status: "incomplete", verified: false, message: "The matching WAV export has no retained mix snapshot. Automatic chapters will be unavailable." };
    if (!Array.isArray(match.timeline) || !match.timeline.length) return { status: "incomplete", verified: false, message: "The matching WAV export has no retained timeline. Automatic chapters will be unavailable." };
    return { status: "verified", verified: true, message: "The WAV has a unique saved mix snapshot and timeline.", ...structuredClone(match) };
  }

  async planMasterRecovery({ masterFilename, mixId }) {
    if (!this.mixStore || !this.mixService) throw new CompilationUnavailableError("Mix recovery is unavailable because the mix services are not configured.");
    if (!safeFilename(masterFilename, ".wav")) throw new CompilationValidationError("Invalid WAV master filename."); const mix = this.mixStore.get(mixId); const associations = this.mixStore.list().flatMap((candidate) => (candidate.exports ?? []).filter((item) => item.filename === masterFilename).map((item) => ({ mixId: candidate.id, record: item })));
    if (associations.some((item) => item.mixId !== mixId) || associations.length > 1) throw new CompilationConflictError("This WAV filename has conflicting export associations across mixes. Recovery was refused.");
    const existingRecord = associations[0]?.record; if (existingRecord?.snapshot && Array.isArray(existingRecord.timeline) && existingRecord.timeline.length) throw new CompilationConflictError("This WAV export already has a verified snapshot and timeline. Recovery cannot replace it.");
    const preview = await this.mixService.preview({ trackIds: mix.trackIds, crossfadeSeconds: mix.crossfadeSeconds });
    const rejected = preview.tracks.filter((track) => this.mixService.library.get(track.id).reviewStatus !== "Keep"); if (rejected.length) throw new CompilationValidationError(`Recovery requires accepted recordings: ${rejected.map((item) => item.title).join(", ")}.`);
    const master = await this.#inspectMaster(masterFilename); if (Math.abs(master.duration - preview.expectedDuration) > this.toleranceSeconds) throw new CompilationConflictError(`The WAV duration differs from the reconstructed mix by ${(master.duration - preview.expectedDuration).toFixed(3)} seconds. Recovery was not offered.`);
    const timeline = buildMixTimeline(preview.tracks, preview.transitions); const evidence = { mixId, mixUpdatedAt: mix.updatedAt, trackIds: preview.tracks.map((item) => item.id), sourceFiles: preview.tracks.map((item) => ({ id: item.id, filename: item.filename, duration: item.duration })), crossfadeSeconds: mix.crossfadeSeconds, masterFilename, masterDuration: master.duration, masterSize: master.stat.size, masterMtimeMs: master.stat.mtimeMs };
    if (Array.isArray(existingRecord?.timeline) && existingRecord.timeline.length && JSON.stringify(existingRecord.timeline) !== JSON.stringify(timeline)) throw new CompilationConflictError("The existing WAV timeline conflicts with the reconstructed timeline. Recovery was refused.");
    if (Number.isFinite(existingRecord?.duration) && Math.abs(existingRecord.duration - master.duration) > this.toleranceSeconds) throw new CompilationConflictError("The existing WAV duration conflicts with the inspected master. Recovery was refused.");
    if (existingRecord?.evidence && !evidenceConsistent(existingRecord.evidence, evidence)) throw new CompilationConflictError("The existing WAV evidence conflicts with the reconstructed provenance. Recovery was refused.");
    const plan = { mixId, masterFilename, expectedDuration: preview.expectedDuration, masterDuration: master.duration, timeline, evidence, existingRecord: existingRecord ? structuredClone(existingRecord) : null, message: "Track identities, saved order, crossfade settings, source durations and WAV duration agree. Review every chapter before accepting recovery." }; return { ...plan, snapshot: crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
  }
  async approveMasterRecovery(input) { const plan = await this.planMasterRecovery(input); if (plan.snapshot !== input.snapshot) throw new CompilationConflictError("The WAV, mix, source recordings or existing export record changed. Review recovery again."); const recovered = { filename: plan.masterFilename, duration: plan.masterDuration, snapshot: `recovered:${plan.snapshot}`, timeline: plan.timeline, recovered: true, evidence: plan.evidence, expectedRecord: plan.existingRecord }; await this.mixStore.recoverExport(plan.mixId, plan.masterFilename, recovered); const { expectedRecord: _expectedRecord, ...result } = recovered; return { ...result, mixId: plan.mixId }; }

  async planExistingVideoRecovery({ filename, masterFilename, mixId }) {
    if (!safeFilename(filename, ".mp4")) throw new CompilationValidationError("Invalid compilation video filename."); const record = this.getExportProvenance(filename); if (!record) throw new CompilationNotFoundError("No retained MP4 provenance record exists. Matching filename or duration alone is insufficient for recovery."); if (record.masterFilename !== masterFilename) throw new CompilationConflictError("The retained MP4 record names a different WAV master. Recovery was refused."); if (!record.outputFingerprint) throw new CompilationConflictError("The retained MP4 record has no fingerprint. Recovery was refused.");
    const master = this.diagnoseMasterProvenance(masterFilename); if (!master.verified || master.mixId !== mixId) throw new CompilationConflictError("Recover the selected WAV-to-mix timeline before associating this MP4."); const videoPath = this.#exportPath(filename); await assertFile(this.fs.stat, videoPath, "The selected compilation MP4 is missing or invalid."); const actualFingerprint = await hashFile(videoPath); if (actualFingerprint !== record.outputFingerprint) throw new CompilationConflictError("The MP4 fingerprint does not match its retained record. Recovery was refused."); const media = await this.probe(videoPath); const duration = media.duration ?? media.streams?.find((item) => item.codecType === "video")?.duration; if (!Number.isFinite(duration) || Math.abs(duration - record.duration) > this.toleranceSeconds) throw new CompilationConflictError("The MP4 duration does not match its retained render record. Recovery was refused.");
    const plan = { filename, masterFilename, mixId, fingerprint: actualFingerprint, duration, mixExportSnapshot: master.snapshot, timeline: master.timeline, message: "The retained MP4 record, fingerprint and WAV identity agree with the recovered mix timeline." }; return { ...plan, snapshot: crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
  }
  async approveExistingVideoRecovery(input) { const plan = await this.planExistingVideoRecovery(input); if (plan.snapshot !== input.snapshot) throw new CompilationConflictError("The MP4 or recovered WAV provenance changed. Review association again."); const current = this.getExportProvenance(plan.filename); const record = { ...current, mixId: plan.mixId, mixExportSnapshot: plan.mixExportSnapshot, timeline: plan.timeline, provenanceStatus: "verified", provenanceDiagnostic: "Explicitly recovered from retained MP4 fingerprint and verified WAV-to-mix evidence.", recoveryHistory: [...(current.recoveryHistory ?? []), { recoveredAt: new Date().toISOString(), mixId: plan.mixId, masterFilename: plan.masterFilename, fingerprint: plan.fingerprint }] }; await this.#persistProvenance(record); return structuredClone(record); }

  async listSources() {
    return {
      masters: await this.#listFiles(this.mixesDirectory, ".wav"),
      assets: await this.#listFiles(this.assetsDirectory, ".mp4"),
    };
  }

  async plan({ masterFilename, assetFilename, title }) {
    this.#assertAvailable();
    const inputs = await this.#inspectInputs(masterFilename, assetFilename);
    const requestedTitle = String(title || path.basename(masterFilename, ".wav")).replace(/\.mp4$/i, "");
    const base = slug(requestedTitle) || "compilation-video";
    let outputFilename = `${base}.mp4`;
    for (let suffix = 2; await exists(this.fs.stat, this.#exportPath(outputFilename)); suffix += 1) outputFilename = `${base}-${suffix}.mp4`;
    const provenance = this.diagnoseMasterProvenance(masterFilename); const plan = {
      master: { filename: masterFilename, duration: inputs.audioDuration },
      asset: { filename: assetFilename, duration: inputs.visualDuration },
      expectedDuration: inputs.audioDuration,
      outputFilename,
      output: { container: "MP4", videoCodec: "H.264", audioCodec: "AAC 320 kbps", width: WIDTH, height: HEIGHT, pixelFormat: "yuv420p", sampleRate: 48000, channels: 2 },
      provenance,
    };
    return { ...plan, snapshot: snapshot(plan, inputs) };
  }

  async render({ masterFilename, assetFilename, outputFilename, snapshot: approvedSnapshot }) {
    this.#assertAvailable();
    if (this.active) throw new CompilationConflictError("Another compilation video is already rendering.");
    if (!safeFilename(outputFilename, ".mp4")) throw new CompilationValidationError("Invalid compilation video filename.");
    this.active = true;
    let temporaryPath;
    let unpublishedFinalPath;
    try {
      const inputs = await this.#inspectInputs(masterFilename, assetFilename);
      const provenance = this.diagnoseMasterProvenance(masterFilename); const approvedPlan = {
        master: { filename: masterFilename, duration: inputs.audioDuration },
        asset: { filename: assetFilename, duration: inputs.visualDuration },
        expectedDuration: inputs.audioDuration,
        outputFilename,
        output: { container: "MP4", videoCodec: "H.264", audioCodec: "AAC 320 kbps", width: WIDTH, height: HEIGHT, pixelFormat: "yuv420p", sampleRate: 48000, channels: 2 },
        provenance,
      };
      if (snapshot(approvedPlan, inputs) !== approvedSnapshot) throw new CompilationConflictError("The WAV master, visual asset, or approved plan changed. Review a new plan before rendering.");
      const finalPath = this.#exportPath(outputFilename);
      if (await exists(this.fs.stat, finalPath)) throw new CompilationConflictError("That compilation video already exists. Review a new plan; nothing was overwritten.");
      temporaryPath = path.join(this.exportsDirectory, `.rendering-${this.randomUUID()}.mp4`);
      await this.runner.run(this.ffmpeg, buildCompilationFfmpegArgs({
        audioPath: inputs.audioPath, assetPath: inputs.assetPath, outputPath: temporaryPath, sourceDuration: inputs.audioDuration,
      }));
      await assertFile(this.fs.stat, temporaryPath, "FFmpeg did not produce a complete compilation video.");
      const outputMedia = await this.probe(temporaryPath);
      validateCompilationOutput(outputMedia, inputs.audioDuration, this.toleranceSeconds);
      if (await exists(this.fs.stat, finalPath)) throw new CompilationConflictError("The output filename became occupied. Nothing was overwritten.");
      try { await this.fs.publish(temporaryPath, finalPath); }
      catch (error) { if (error?.code === "EEXIST") throw new CompilationConflictError("The output filename became occupied. Nothing was overwritten."); throw error; }
      unpublishedFinalPath = finalPath;
      await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      const mixProvenance = provenance.verified ? provenance : undefined;
      const record = { filename: outputFilename, outputFingerprint: await hashFile(finalPath), masterFilename, assetFilename, duration: inputs.audioDuration, mixId: mixProvenance?.mixId, mixExportSnapshot: mixProvenance?.snapshot, timeline: mixProvenance?.timeline, provenanceStatus: provenance.status, provenanceDiagnostic: provenance.message, createdAt: new Date().toISOString() };
      try { await this.#persistProvenance(record); } catch (error) { await this.fs.rm(finalPath, { force: true }).catch(() => {}); throw error; }
      unpublishedFinalPath = undefined;
      return { filename: outputFilename, duration: inputs.audioDuration, downloadUrl: `/compilation-videos/${encodeURIComponent(outputFilename)}` };
    } catch (error) {
      if (temporaryPath) await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      if (unpublishedFinalPath) await this.fs.rm(unpublishedFinalPath, { force: true }).catch(() => {});
      throw error;
    } finally { this.active = false; }
  }

  async #inspectInputs(masterFilename, assetFilename) {
    if (!safeFilename(masterFilename, ".wav")) throw new CompilationValidationError("Invalid WAV master filename.");
    if (!safeFilename(assetFilename, ".mp4")) throw new CompilationValidationError("Invalid visual asset filename.");
    const audioPath = safeChild(this.mixesDirectory, masterFilename, ".wav");
    const assetPath = safeChild(this.assetsDirectory, assetFilename, ".mp4");
    const [audioStat, assetStat] = await Promise.all([
      assertFile(this.fs.stat, audioPath, "The selected WAV master is missing or invalid."),
      assertFile(this.fs.stat, assetPath, "The selected visual asset is missing or invalid."),
    ]);
    await Promise.all([
      assertRealFileInside(this.fs.realpath, audioPath, this.mixesDirectory, "The selected WAV master must remain inside the mixes directory."),
      assertRealFileInside(this.fs.realpath, assetPath, this.assetsDirectory, "The selected visual asset must remain inside the visual-assets directory."),
    ]);
    const [audioMedia, assetMedia] = await Promise.all([this.probe(audioPath), this.probe(assetPath)]);
    const audio = audioMedia.streams?.find((stream) => stream.codecType === "audio");
    const video = assetMedia.streams?.find((stream) => stream.codecType === "video");
    const audioDuration = audio?.duration ?? audioMedia.duration;
    const visualDuration = video?.duration ?? assetMedia.duration;
    if (!audio || audio.codecName !== "pcm_s24le" || audio.sampleRate !== 48000 || audio.channels !== 2
      || !String(audioMedia.formatName ?? "").split(",").includes("wav") || !Number.isFinite(audioDuration) || !(audioDuration > this.minimumSourceDuration)) {
      throw new CompilationValidationError(`The selected source must be a completed WAV master strictly longer than ${formatDuration(this.minimumSourceDuration)}.`);
    }
    if (!video || !video.width || !video.height || !Number.isFinite(visualDuration) || visualDuration <= 0) throw new CompilationValidationError("The selected visual asset has no usable video stream or duration.");
    return { audioPath, assetPath, audioDuration, visualDuration, audioStat, assetStat };
  }

  async #inspectMaster(masterFilename) { const filePath = safeChild(this.mixesDirectory, masterFilename, ".wav"); const statValue = await assertFile(this.fs.stat, filePath, "The selected WAV master is missing or invalid."); await assertRealFileInside(this.fs.realpath, filePath, this.mixesDirectory, "The selected WAV master must remain inside the mixes directory."); const media = await this.probe(filePath); const audio = media.streams?.find((item) => item.codecType === "audio"); const duration = audio?.duration ?? media.duration; if (!audio || !Number.isFinite(duration) || duration <= 0) throw new CompilationValidationError("The selected WAV master has no valid audio duration."); return { duration, stat: statValue }; }

  async #listFiles(directory, extension) {
    const result = [];
    for (const entry of await this.fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !safeFilename(entry.name, extension)) continue;
      const details = await this.fs.stat(path.join(directory, entry.name));
      if (details.size > 0) result.push({ filename: entry.name, size: details.size });
    }
    return result.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  #assertAvailable() { if (!this.available) throw new CompilationUnavailableError(this.error ?? "FFmpeg/FFprobe is unavailable."); }
  #exportPath(filename) { return safeChild(this.exportsDirectory, filename, ".mp4"); }
  async #persistProvenance(record) {
    const next = [...this.provenance.filter((item) => item.filename !== record.filename), record];
    const temporary = path.join(this.outputDirectory, `.compilation-provenance-${this.randomUUID()}.tmp`);
    try { await this.fs.writeFile(temporary, `${JSON.stringify({ version: 1, exports: next }, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await this.fs.rename(temporary, this.provenancePath); this.provenance = next; }
    catch (error) { await this.fs.rm(temporary, { force: true }).catch(() => {}); throw new CompilationRenderError("The completed video could not be linked to its source mix, so it was not published."); }
  }
}

export function buildCompilationFfmpegArgs({ audioPath, assetPath, outputPath, sourceDuration }) {
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new CompilationValidationError("A valid probed WAV duration is required before rendering.");
  return [
    "-hide_banner", "-n", "-stream_loop", "-1", "-i", assetPath, "-i", audioPath,
    "-filter_complex", "[0:v:0]setpts=N/FRAME_RATE/TB,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[v];[1:a:0]asetpts=N/SR/TB[a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2",
    "-t", sourceDuration.toFixed(6), "-movflags", "+faststart", "-progress", "pipe:2", "-nostats", outputPath,
  ];
}

export function validateCompilationOutput(media, sourceDuration, tolerance = 1.5) {
  const video = media?.streams?.find((stream) => stream.codecType === "video");
  const audio = media?.streams?.find((stream) => stream.codecType === "audio");
  const audioDuration = audio?.duration;
  const videoDuration = video?.duration;
  const containerDuration = media?.duration;
  if (!String(media?.formatName ?? "").split(",").some((name) => name === "mp4" || name === "mov")) throw new CompilationRenderError("Rendered output is not a valid MP4 container.");
  if (video?.codecName !== "h264" || video.width !== WIDTH || video.height !== HEIGHT || video.pixelFormat !== "yuv420p") throw new CompilationRenderError("Rendered video must be H.264, 1920 × 1080, yuv420p.");
  if (audio?.codecName !== "aac" || audio.sampleRate !== 48000 || audio.channels !== 2) throw new CompilationRenderError("Rendered audio must be AAC, 48 kHz stereo.");
  if (![audioDuration, videoDuration, containerDuration].every(Number.isFinite)
    || Math.abs(audioDuration - sourceDuration) > tolerance
    || Math.abs(videoDuration - sourceDuration) > tolerance
    || Math.abs(containerDuration - sourceDuration) > tolerance) {
    throw new CompilationRenderError(`Rendered duration does not closely match the complete WAV master; no output was published. ${durationDiagnostics(sourceDuration, audioDuration, videoDuration, containerDuration)}`);
  }
  return { duration: containerDuration, audioDuration, videoDuration, width: video.width, height: video.height };
}

function durationDiagnostics(expected, audio, video, container) {
  const describe = (label, actual) => Number.isFinite(actual)
    ? `${label}: ${actual.toFixed(3)}s (difference ${(actual - expected).toFixed(3)}s)`
    : `${label}: unknown (difference unknown)`;
  return `Expected WAV duration: ${expected.toFixed(3)}s. ${describe("Actual encoded audio duration", audio)}. ${describe("Actual video stream duration", video)}. ${describe("Actual MP4 container duration", container)}.`;
}

function snapshot(plan, inputs) {
  return crypto.createHash("sha256").update(JSON.stringify({
    plan, audio: { size: inputs.audioStat.size, mtimeMs: inputs.audioStat.mtimeMs },
    asset: { size: inputs.assetStat.size, mtimeMs: inputs.assetStat.mtimeMs },
  })).digest("hex");
}
function evidenceConsistent(existing, proposed) {
  if (Array.isArray(existing)) return Array.isArray(proposed) && existing.length === proposed.length && existing.every((value, index) => evidenceConsistent(value, proposed[index]));
  if (existing && typeof existing === "object") return proposed && typeof proposed === "object" && Object.entries(existing).every(([key, value]) => evidenceConsistent(value, proposed[key]));
  return Object.is(existing, proposed);
}
function safeFilename(filename, extension) { return typeof filename === "string" && filename.length <= 180 && path.basename(filename) === filename && path.extname(filename).toLowerCase() === extension && !filename.startsWith(".") && !/[<>:"/\\|?*\x00-\x1f]/.test(filename); }
function safeChild(directory, filename, extension) { if (!safeFilename(filename, extension)) throw new CompilationValidationError("Unsafe media filename."); const resolved = path.resolve(directory, filename); if (path.dirname(resolved) !== path.resolve(directory)) throw new CompilationValidationError("Media path escaped its designated directory."); return resolved; }
async function exists(statFn, filePath) { try { await statFn(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function assertFile(statFn, filePath, message) { try { const details = await statFn(filePath); if (!details.isFile?.() || details.size <= 0) throw new Error(); return details; } catch { throw new CompilationNotFoundError(message); } }
async function assertRealFileInside(realpathFn, filePath, directory, message) { try { const [resolvedFile, resolvedDirectory] = await Promise.all([realpathFn(filePath), realpathFn(directory)]); if (path.dirname(resolvedFile) !== resolvedDirectory) throw new Error(); } catch { throw new CompilationValidationError(message); } }
async function hashFile(filePath) { const hash = crypto.createHash("sha256"); await pipeline(createReadStream(filePath), new Writable({ write(chunk, _encoding, callback) { hash.update(chunk); callback(); } })); return hash.digest("hex"); }
function slug(value) { return String(value ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 160); }
function formatDuration(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`; }

export class CompilationValidationError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class CompilationNotFoundError extends Error { constructor(message) { super(message); this.statusCode = 404; } }
export class CompilationConflictError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class CompilationUnavailableError extends Error { constructor(message) { super(message); this.statusCode = 503; } }
export class CompilationRenderError extends Error { constructor(message) { super(message); this.statusCode = 500; } }
