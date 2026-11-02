import crypto from "node:crypto";
import path from "node:path";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";

export const VISUAL_ASSETS_DIRECTORY = "visual-assets";
export const VIDEO_EXPORTS_DIRECTORY = "videos";

export class VideoAssemblyService {
  constructor(outputDirectory, library, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.assetsDirectory = path.join(this.outputDirectory, VISUAL_ASSETS_DIRECTORY);
    this.exportsDirectory = path.join(this.outputDirectory, VIDEO_EXPORTS_DIRECTORY);
    this.library = library;
    this.executable = dependencies.executable ?? "ffmpeg";
    this.runner = dependencies.runner ?? new SpawnProcessRunner();
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir,
      readdir: dependencies.readdir ?? readdir,
      publish: dependencies.publish ?? ((source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL)),
      rm: dependencies.rm ?? rm,
      stat: dependencies.stat ?? stat,
    };
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.available = false;
    this.availabilityError = undefined;
    this.activeJob = undefined;
  }

  async initialize() {
    await this.fs.mkdir(this.assetsDirectory, { recursive: true });
    await this.fs.mkdir(this.exportsDirectory, { recursive: true });
    await this.#removeInterruptedOutputs();
    try {
      await this.runner.check(this.executable);
      this.available = true;
      this.availabilityError = undefined;
    } catch (error) {
      this.available = false;
      this.availabilityError = `FFmpeg is unavailable at “${this.executable}”. Install FFmpeg locally or set FFMPEG_PATH, then restart the app. ${error.message}`;
    }
    return this.status();
  }

  status() {
    return {
      available: this.available,
      error: this.availabilityError,
      active: Boolean(this.activeJob),
      executable: this.executable,
    };
  }

  async listAssets() {
    const entries = await this.fs.readdir(this.assetsDirectory, { withFileTypes: true });
    const assets = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isSafeMediaFilename(entry.name, ".mp4")) continue;
      const details = await this.fs.stat(this.#assetPath(entry.name));
      if (details.size > 0) assets.push({ filename: entry.name, size: details.size });
    }
    return assets.sort((left, right) => left.filename.localeCompare(right.filename));
  }

  async plan(trackId, assetFilename) {
    this.#assertAvailable();
    const { track, audioPath, assetPath } = await this.#validateInputs(trackId, assetFilename);
    const base = `${slug(track.title)}-${slug(path.basename(assetFilename, ".mp4"))}`.slice(0, 150) || "music-video";
    let outputFilename = `${base}.mp4`;
    for (let suffix = 2; await this.#exists(this.#exportPath(outputFilename)); suffix += 1) {
      outputFilename = `${base}-${suffix}.mp4`;
    }
    return {
      track: { id: track.id, title: track.title, filename: track.filename },
      asset: { filename: assetFilename },
      outputFilename,
      audioPath,
      assetPath,
    };
  }

  async render({ trackId, assetFilename, outputFilename }, onProgress = () => {}) {
    this.#assertAvailable();
    if (this.activeJob) throw new VideoConflictError("Another video export is already running. Wait for it to finish.");
    if (!isSafeMediaFilename(outputFilename, ".mp4")) throw new VideoValidationError("Invalid video output filename.");
    const job = { trackId, assetFilename, outputFilename, startedAt: new Date().toISOString() };
    this.activeJob = job;
    let temporaryPath;
    try {
      const inputs = await this.#validateInputs(trackId, assetFilename);
      const finalPath = this.#exportPath(outputFilename);
      if (await this.#exists(finalPath)) throw new VideoConflictError("That video output already exists. Create a new export plan; nothing was overwritten.");
      const temporaryFilename = `.rendering-${this.randomUUID()}.mp4`;
      temporaryPath = path.join(this.exportsDirectory, temporaryFilename);
      const args = buildFfmpegArgs({ audioPath: inputs.audioPath, assetPath: inputs.assetPath, outputPath: temporaryPath });
      await this.runner.run(this.executable, args, { onProgress });
      const output = await this.fs.stat(temporaryPath);
      if (!output.isFile?.() || output.size <= 0) throw new VideoRenderError("FFmpeg completed without producing a valid MP4.");
      try {
        await this.fs.publish(temporaryPath, finalPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new VideoConflictError("The intended output filename became occupied during rendering. The temporary export was removed and nothing was overwritten.");
        }
        throw error;
      }
      await this.fs.rm(temporaryPath).catch(() => {});
      return {
        filename: outputFilename,
        downloadUrl: `/videos/${encodeURIComponent(outputFilename)}`,
        track: { id: inputs.track.id, title: inputs.track.title, filename: inputs.track.filename },
        asset: { filename: assetFilename },
      };
    } catch (error) {
      if (temporaryPath) await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    } finally {
      this.activeJob = undefined;
    }
  }

  async #validateInputs(trackId, assetFilename) {
    if (typeof trackId !== "string") throw new VideoValidationError("Select a Track Library recording.");
    if (!isSafeMediaFilename(assetFilename, ".mp4")) throw new VideoValidationError("Invalid visual asset filename.");
    let track;
    try {
      track = this.library.get(trackId);
    } catch {
      throw new VideoNotFoundError("Track Library recording not found.");
    }
    if (!isSafeMediaFilename(track.filename, ".mp3")) throw new VideoValidationError("The recording has an invalid MP3 filename.");
    const audioPath = path.join(this.outputDirectory, track.filename);
    const assetPath = this.#assetPath(assetFilename);
    await assertNonEmptyFile(this.fs.stat, audioPath, "The selected MP3 is missing or invalid.");
    await assertNonEmptyFile(this.fs.stat, assetPath, "The selected visual asset is missing or invalid.");
    return { track, audioPath, assetPath };
  }

  #assertAvailable() {
    if (!this.available) throw new VideoUnavailableError(this.availabilityError ?? "FFmpeg is unavailable. Restart after configuring FFMPEG_PATH.");
  }

  #assetPath(filename) {
    return safeChildPath(this.assetsDirectory, filename, ".mp4");
  }

  #exportPath(filename) {
    return safeChildPath(this.exportsDirectory, filename, ".mp4");
  }

  async #exists(filePath) {
    try {
      await this.fs.stat(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async #removeInterruptedOutputs() {
    const entries = await this.fs.readdir(this.exportsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && /^\.rendering-[a-zA-Z0-9-]+\.mp4$/.test(entry.name)) {
        await this.fs.rm(path.join(this.exportsDirectory, entry.name), { force: true });
      }
    }
  }
}

export function buildFfmpegArgs({ audioPath, assetPath, outputPath }) {
  return [
    "-hide_banner", "-n",
    "-stream_loop", "-1", "-i", assetPath,
    "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-shortest",
    "-progress", "pipe:2", "-nostats",
    outputPath,
  ];
}

export class SpawnProcessRunner {
  check(executable) {
    return runSpawn(executable, ["-version"]);
  }

  run(executable, args, { onProgress } = {}) {
    return runSpawn(executable, args, onProgress);
  }
}

function runSpawn(executable, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
      for (const line of chunk.split(/\r?\n/)) if (line.startsWith("out_time=")) onProgress?.(line.slice("out_time=".length));
    });
    child.once("error", (error) => reject(new VideoUnavailableError(`Could not start FFmpeg: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new VideoRenderError(signal
        ? `FFmpeg was interrupted by signal ${signal}. No completed video was published.`
        : `FFmpeg exited with code ${code}. No completed video was published. ${stderr.trim()}`));
    });
  });
}

function safeChildPath(directory, filename, extension) {
  if (!isSafeMediaFilename(filename, extension)) throw new VideoValidationError("Invalid media filename.");
  const resolved = path.resolve(directory, filename);
  if (path.dirname(resolved) !== path.resolve(directory)) throw new VideoValidationError("Media path must remain inside its designated directory.");
  return resolved;
}

function isSafeMediaFilename(filename, extension) {
  return typeof filename === "string" && filename.length <= 180 && path.basename(filename) === filename
    && path.extname(filename).toLowerCase() === extension && !filename.startsWith(".")
    && !/[<>:"/\\|?*\x00-\x1f]/.test(filename);
}

async function assertNonEmptyFile(statFn, filePath, message) {
  try {
    const details = await statFn(filePath);
    if (!details.isFile?.() || details.size <= 0) throw new Error("empty");
  } catch {
    throw new VideoNotFoundError(message);
  }
}

function slug(value) {
  return String(value ?? "").normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

export class VideoValidationError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class VideoNotFoundError extends Error { constructor(message) { super(message); this.statusCode = 404; } }
export class VideoConflictError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class VideoUnavailableError extends Error { constructor(message) { super(message); this.statusCode = 503; } }
export class VideoRenderError extends Error { constructor(message) { super(message); this.statusCode = 500; } }
