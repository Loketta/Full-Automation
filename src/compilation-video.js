import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { MIXES_DIRECTORY, MINIMUM_MIX_DURATION_SECONDS } from "./mixes.js";
import { probeMedia, SpawnProcessRunner, VISUAL_ASSETS_DIRECTORY } from "./video.js";

export const COMPILATION_VIDEOS_DIRECTORY = "compilation-videos";
const WIDTH = 1920;
const HEIGHT = 1080;

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
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir, readdir: dependencies.readdir ?? readdir,
      rm: dependencies.rm ?? rm, stat: dependencies.stat ?? stat,
      publish: dependencies.publish ?? ((source, destination) => rename(source, destination)),
      realpath: dependencies.realpath ?? realpath,
    };
    this.available = false;
    this.error = undefined;
    this.active = false;
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
    const plan = {
      master: { filename: masterFilename, duration: inputs.audioDuration },
      asset: { filename: assetFilename, duration: inputs.visualDuration },
      expectedDuration: inputs.audioDuration,
      outputFilename,
      output: { container: "MP4", videoCodec: "H.264", audioCodec: "AAC 320 kbps", width: WIDTH, height: HEIGHT, pixelFormat: "yuv420p", sampleRate: 48000, channels: 2 },
    };
    return { ...plan, snapshot: snapshot(plan, inputs) };
  }

  async render({ masterFilename, assetFilename, outputFilename, snapshot: approvedSnapshot }) {
    this.#assertAvailable();
    if (this.active) throw new CompilationConflictError("Another compilation video is already rendering.");
    if (!safeFilename(outputFilename, ".mp4")) throw new CompilationValidationError("Invalid compilation video filename.");
    this.active = true;
    let temporaryPath;
    try {
      const inputs = await this.#inspectInputs(masterFilename, assetFilename);
      const approvedPlan = {
        master: { filename: masterFilename, duration: inputs.audioDuration },
        asset: { filename: assetFilename, duration: inputs.visualDuration },
        expectedDuration: inputs.audioDuration,
        outputFilename,
        output: { container: "MP4", videoCodec: "H.264", audioCodec: "AAC 320 kbps", width: WIDTH, height: HEIGHT, pixelFormat: "yuv420p", sampleRate: 48000, channels: 2 },
      };
      if (snapshot(approvedPlan, inputs) !== approvedSnapshot) throw new CompilationConflictError("The WAV master, visual asset, or approved plan changed. Review a new plan before rendering.");
      const finalPath = this.#exportPath(outputFilename);
      if (await exists(this.fs.stat, finalPath)) throw new CompilationConflictError("That compilation video already exists. Review a new plan; nothing was overwritten.");
      temporaryPath = path.join(this.exportsDirectory, `.rendering-${this.randomUUID()}.mp4`);
      await this.runner.run(this.ffmpeg, buildCompilationFfmpegArgs({ audioPath: inputs.audioPath, assetPath: inputs.assetPath, outputPath: temporaryPath }));
      await assertFile(this.fs.stat, temporaryPath, "FFmpeg did not produce a complete compilation video.");
      const outputMedia = await this.probe(temporaryPath);
      validateCompilationOutput(outputMedia, inputs.audioDuration, this.toleranceSeconds);
      if (await exists(this.fs.stat, finalPath)) throw new CompilationConflictError("The output filename became occupied. Nothing was overwritten.");
      try { await this.fs.publish(temporaryPath, finalPath); }
      catch (error) { if (error?.code === "EEXIST") throw new CompilationConflictError("The output filename became occupied. Nothing was overwritten."); throw error; }
      await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      return { filename: outputFilename, duration: inputs.audioDuration, downloadUrl: `/compilation-videos/${encodeURIComponent(outputFilename)}` };
    } catch (error) {
      if (temporaryPath) await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
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
}

export function buildCompilationFfmpegArgs({ audioPath, assetPath, outputPath }) {
  return [
    "-hide_banner", "-n", "-stream_loop", "-1", "-i", assetPath, "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart", "-shortest", "-progress", "pipe:2", "-nostats", outputPath,
  ];
}

export function validateCompilationOutput(media, sourceDuration, tolerance = 1.5) {
  const video = media?.streams?.find((stream) => stream.codecType === "video");
  const audio = media?.streams?.find((stream) => stream.codecType === "audio");
  const audioDuration = audio?.duration ?? media?.duration;
  const containerDuration = media?.duration ?? audioDuration;
  if (!String(media?.formatName ?? "").split(",").some((name) => name === "mp4" || name === "mov")) throw new CompilationRenderError("Rendered output is not a valid MP4 container.");
  if (video?.codecName !== "h264" || video.width !== WIDTH || video.height !== HEIGHT || video.pixelFormat !== "yuv420p") throw new CompilationRenderError("Rendered video must be H.264, 1920 × 1080, yuv420p.");
  if (audio?.codecName !== "aac" || audio.sampleRate !== 48000 || audio.channels !== 2) throw new CompilationRenderError("Rendered audio must be AAC, 48 kHz stereo.");
  if (!Number.isFinite(audioDuration) || !Number.isFinite(containerDuration)
    || Math.abs(audioDuration - sourceDuration) > tolerance || Math.abs(containerDuration - sourceDuration) > tolerance) {
    throw new CompilationRenderError("Rendered duration does not closely match the complete WAV master; no output was published.");
  }
  return { duration: containerDuration, audioDuration, width: video.width, height: video.height };
}

function snapshot(plan, inputs) {
  return crypto.createHash("sha256").update(JSON.stringify({
    plan, audio: { size: inputs.audioStat.size, mtimeMs: inputs.audioStat.mtimeMs },
    asset: { size: inputs.assetStat.size, mtimeMs: inputs.assetStat.mtimeMs },
  })).digest("hex");
}
function safeFilename(filename, extension) { return typeof filename === "string" && filename.length <= 180 && path.basename(filename) === filename && path.extname(filename).toLowerCase() === extension && !filename.startsWith(".") && !/[<>:"/\\|?*\x00-\x1f]/.test(filename); }
function safeChild(directory, filename, extension) { if (!safeFilename(filename, extension)) throw new CompilationValidationError("Unsafe media filename."); const resolved = path.resolve(directory, filename); if (path.dirname(resolved) !== path.resolve(directory)) throw new CompilationValidationError("Media path escaped its designated directory."); return resolved; }
async function exists(statFn, filePath) { try { await statFn(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function assertFile(statFn, filePath, message) { try { const details = await statFn(filePath); if (!details.isFile?.() || details.size <= 0) throw new Error(); return details; } catch { throw new CompilationNotFoundError(message); } }
async function assertRealFileInside(realpathFn, filePath, directory, message) { try { const [resolvedFile, resolvedDirectory] = await Promise.all([realpathFn(filePath), realpathFn(directory)]); if (path.dirname(resolvedFile) !== resolvedDirectory) throw new Error(); } catch { throw new CompilationValidationError(message); } }
function slug(value) { return String(value ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 160); }
function formatDuration(seconds) { return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`; }

export class CompilationValidationError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class CompilationNotFoundError extends Error { constructor(message) { super(message); this.statusCode = 404; } }
export class CompilationConflictError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class CompilationUnavailableError extends Error { constructor(message) { super(message); this.statusCode = 503; } }
export class CompilationRenderError extends Error { constructor(message) { super(message); this.statusCode = 500; } }
