import crypto from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { probeMedia, SpawnProcessRunner } from "./video.js";

export const MIXES_DIRECTORY = "mixes";
export const MINIMUM_MIX_DURATION_SECONDS = 3720;
export const DEFAULT_CROSSFADE_SECONDS = 8;
const MIXES_FILENAME = "mixes.json";

export class MixStore {
  constructor(outputDirectory, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.filePath = path.join(this.outputDirectory, MIXES_FILENAME);
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir, readFile: dependencies.readFile ?? readFile,
      rename: dependencies.rename ?? rename, rm: dependencies.rm ?? rm, writeFile: dependencies.writeFile ?? writeFile,
    };
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.data = { version: 1, mixes: [] };
    this.queue = Promise.resolve();
  }

  initialize() {
    return this.#exclusive(async () => {
      await this.fs.mkdir(this.outputDirectory, { recursive: true });
      try {
        const parsed = JSON.parse(await this.fs.readFile(this.filePath, "utf8"));
        if (parsed?.version !== 1 || !Array.isArray(parsed.mixes)) throw new Error("Unsupported mix metadata format.");
        this.data = { version: 1, mixes: parsed.mixes.filter(isStoredMix) };
      } catch (error) {
        if (error?.code !== "ENOENT") throw new Error(`Could not read ${MIXES_FILENAME}: ${error.message}`);
      }
      return this.list();
    });
  }

  list() { return structuredClone(this.data.mixes).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id) {
    const mix = this.data.mixes.find((candidate) => candidate.id === id);
    if (!mix) throw new MixNotFoundError();
    return structuredClone(mix);
  }

  create(values) {
    return this.#exclusive(async () => {
      const now = this.now().toISOString();
      const mix = normalizeDraft({ ...values, id: this.randomUUID(), exports: [], createdAt: now, updatedAt: now });
      await this.#mutateAndPersist((next) => next.mixes.push(mix));
      return structuredClone(mix);
    });
  }

  update(id, values) {
    return this.#exclusive(async () => {
      const current = this.data.mixes.find((mix) => mix.id === id);
      if (!current) throw new MixNotFoundError();
      const updated = normalizeDraft({ ...current, ...values, id, exports: current.exports, createdAt: current.createdAt, updatedAt: this.now().toISOString() });
      await this.#mutateAndPersist((next) => Object.assign(next.mixes.find((mix) => mix.id === id), updated));
      return structuredClone(updated);
    });
  }

  recordExport(id, exported) {
    return this.#exclusive(async () => {
      await this.#mutateAndPersist((next) => {
        const mix = next.mixes.find((candidate) => candidate.id === id);
        if (!mix) throw new MixNotFoundError();
        mix.exports.push(exported);
        mix.updatedAt = this.now().toISOString();
      });
      return this.get(id);
    });
  }

  async #mutateAndPersist(mutate) {
    const next = structuredClone(this.data);
    mutate(next);
    const temporaryPath = path.join(this.outputDirectory, `.mixes.${this.randomUUID()}.tmp`);
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await this.fs.rename(temporaryPath, this.filePath);
      this.data = next;
    } catch (error) {
      await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  #exclusive(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}

export class MixAssemblyService {
  constructor(outputDirectory, library, store, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.mixesDirectory = path.join(this.outputDirectory, MIXES_DIRECTORY);
    this.library = library;
    this.store = store;
    this.ffmpeg = dependencies.ffmpeg ?? "ffmpeg";
    this.ffprobe = dependencies.ffprobe ?? "ffprobe";
    this.runner = dependencies.runner ?? new SpawnProcessRunner();
    this.probe = dependencies.probe ?? ((filePath) => probeMedia(this.runner, this.ffprobe, filePath));
    this.minimumDurationSeconds = dependencies.minimumDurationSeconds ?? MINIMUM_MIX_DURATION_SECONDS;
    this.toleranceSeconds = dependencies.toleranceSeconds ?? 1;
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir, readdir: dependencies.readdir ?? readdir,
      rm: dependencies.rm ?? rm, stat: dependencies.stat ?? stat,
      publish: dependencies.publish ?? ((source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL)),
    };
    this.available = false;
    this.error = undefined;
    this.active = false;
  }

  async initialize() {
    await this.fs.mkdir(this.mixesDirectory, { recursive: true });
    for (const entry of await this.fs.readdir(this.mixesDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^\.rendering-[a-zA-Z0-9-]+\.wav$/.test(entry.name)) await this.fs.rm(path.join(this.mixesDirectory, entry.name), { force: true });
    }
    try {
      await this.runner.check(this.ffmpeg);
      await this.runner.check(this.ffprobe);
      this.available = true;
    } catch (error) {
      this.available = false;
      this.error = `FFmpeg/FFprobe is unavailable. Configure FFMPEG_PATH and FFPROBE_PATH, then restart. ${error.message}`;
    }
    return this.status();
  }

  status() { return { available: this.available, error: this.error, active: this.active }; }

  validateDraftTracks(trackIds) {
    if (!Array.isArray(trackIds) || trackIds.length < 2) throw new MixValidationError("Select at least two Track Library recordings.");
    if (new Set(trackIds).size !== trackIds.length) throw new MixValidationError("A recording may appear only once in this mix.");
    return trackIds.map((id) => {
      try { return this.library.get(id); } catch { throw new MixValidationError("Every mix item must be an existing Track Library recording."); }
    });
  }

  async plan(mixId) {
    this.#assertAvailable();
    const mix = this.store.get(mixId);
    const tracks = this.validateDraftTracks(mix.trackIds);
    const plannedTracks = [];
    for (const track of tracks) {
      const filePath = this.#audioPath(track.filename);
      await assertFile(this.fs.stat, filePath);
      const media = await this.probe(filePath);
      const audio = media.streams?.find((stream) => stream.codecType === "audio");
      const duration = audio?.duration ?? media.duration;
      if (!audio || !Number.isFinite(duration) || duration <= 0) throw new MixValidationError(`Recording “${track.title}” has no valid audio duration.`);
      const details = await this.fs.stat(filePath);
      plannedTracks.push({ id: track.id, title: track.title, filename: track.filename, duration, size: details.size, mtimeMs: details.mtimeMs, filePath });
    }
    const transitions = buildTransitions(mix.trackIds, mix.crossfadeSeconds);
    const summary = calculateMixDuration(plannedTracks, transitions);
    validateTransitions(plannedTracks, transitions);
    if (!(summary.expectedDuration > this.minimumDurationSeconds)) {
      throw new MixValidationError(`Expected mix duration must be strictly greater than ${formatDuration(this.minimumDurationSeconds)}.`);
    }
    const base = slug(mix.title) || "audio-mix";
    let outputFilename = `${base}.wav`;
    for (let suffix = 2; await exists(this.fs.stat, this.#mixPath(outputFilename)); suffix += 1) outputFilename = `${base}-${suffix}.wav`;
    const snapshot = approvalSnapshot(mix, plannedTracks, transitions, summary);
    return { mixId, title: mix.title, tracks: plannedTracks.map(({ filePath, size, mtimeMs, ...track }) => track), transitions, ...summary, outputFilename, snapshot };
  }

  async render({ mixId, outputFilename, snapshot }) {
    this.#assertAvailable();
    if (this.active) throw new MixConflictError("Another audio mix is already rendering.");
    if (!safeFilename(outputFilename, ".wav")) throw new MixValidationError("Invalid WAV output filename.");
    this.active = true;
    let temporaryPath;
    let finalPath;
    try {
      const plan = await this.plan(mixId);
      if (plan.snapshot !== snapshot || plan.outputFilename !== outputFilename) throw new MixConflictError("The mix plan or source files changed. Review and approve a new plan.");
      finalPath = this.#mixPath(outputFilename);
      if (await exists(this.fs.stat, finalPath)) throw new MixConflictError("That mix output already exists. Nothing was overwritten.");
      temporaryPath = path.join(this.mixesDirectory, `.rendering-${this.randomUUID()}.wav`);
      const tracks = plan.tracks.map((track) => ({ ...track, filePath: this.#audioPath(track.filename) }));
      await this.runner.run(this.ffmpeg, buildMixFfmpegArgs({ tracks, transitions: plan.transitions, outputPath: temporaryPath }));
      await assertFile(this.fs.stat, temporaryPath);
      const outputMedia = await this.probe(temporaryPath);
      validateMixOutput(outputMedia, plan.expectedDuration, this.minimumDurationSeconds, this.toleranceSeconds);
      try { await this.fs.publish(temporaryPath, finalPath); }
      catch (error) { if (error?.code === "EEXIST") throw new MixConflictError("The output filename became occupied. Nothing was overwritten."); throw error; }
      await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      const exported = { filename: outputFilename, createdAt: this.now().toISOString(), duration: plan.expectedDuration, snapshot };
      try { await this.store.recordExport(mixId, exported); }
      catch (error) { await this.fs.rm(finalPath, { force: true }).catch(() => {}); throw error; }
      return { ...exported, downloadUrl: `/mixes/${encodeURIComponent(outputFilename)}` };
    } catch (error) {
      if (temporaryPath) await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    } finally { this.active = false; }
  }

  #assertAvailable() { if (!this.available) throw new MixUnavailableError(this.error ?? "FFmpeg/FFprobe is unavailable."); }
  #audioPath(filename) {
    if (!safeFilename(filename, ".mp3")) throw new MixValidationError("Invalid MP3 filename.");
    return safeChild(this.outputDirectory, filename, ".mp3");
  }
  #mixPath(filename) { return safeChild(this.mixesDirectory, filename, ".wav"); }
}

export function buildTransitions(trackIds, crossfadeSeconds) {
  const duration = validateCrossfade(crossfadeSeconds);
  return trackIds.slice(0, -1).map((fromTrackId, index) => ({ fromTrackId, toTrackId: trackIds[index + 1], duration }));
}

export function calculateMixDuration(tracks, transitions) {
  const totalSourceDuration = tracks.reduce((sum, track) => sum + track.duration, 0);
  const totalCrossfadeOverlap = transitions.reduce((sum, transition) => sum + transition.duration, 0);
  return { totalSourceDuration, totalCrossfadeOverlap, expectedDuration: totalSourceDuration - totalCrossfadeOverlap };
}

export function buildMixFfmpegArgs({ tracks, transitions, outputPath }) {
  const args = ["-hide_banner", "-n"];
  for (const track of tracks) args.push("-i", track.filePath);
  const filters = tracks.map((_track, index) => `[${index}:a]aresample=48000,aformat=sample_fmts=s32:channel_layouts=stereo[a${index}]`);
  let current = "a0";
  for (let index = 1; index < tracks.length; index += 1) {
    const next = `m${index}`;
    const duration = transitions[index - 1].duration;
    filters.push(duration > 0
      ? `[${current}][a${index}]acrossfade=d=${duration}:c1=qsin:c2=qsin[${next}]`
      : `[${current}][a${index}]concat=n=2:v=0:a=1[${next}]`);
    current = next;
  }
  args.push("-filter_complex", filters.join(";"), "-map", `[${current}]`, "-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2", "-f", "wav", outputPath);
  return args;
}

export function validateMixOutput(media, plannedDuration, minimumDuration, tolerance = 1) {
  const audio = media?.streams?.find((stream) => stream.codecType === "audio");
  const duration = audio?.duration ?? media?.duration;
  if (!String(media?.formatName ?? "").split(",").includes("wav")) throw new MixRenderError("Rendered master is not a valid WAV container.");
  if (audio?.codecName !== "pcm_s24le") throw new MixRenderError("Rendered master is not 24-bit PCM audio.");
  if (audio.sampleRate !== 48000 || audio.channels !== 2) throw new MixRenderError("Rendered master must be 48,000 Hz stereo.");
  if (!Number.isFinite(duration) || Math.abs(duration - plannedDuration) > tolerance) throw new MixRenderError("Rendered master duration does not match the approved plan.");
  if (!(duration > minimumDuration)) throw new MixRenderError("Rendered master does not exceed the minimum duration.");
  return duration;
}

function validateTransitions(tracks, transitions) {
  transitions.forEach((transition, index) => {
    if (transition.duration >= tracks[index].duration || transition.duration >= tracks[index + 1].duration) {
      throw new MixValidationError(`Crossfade ${index + 1} must be shorter than both adjacent recordings.`);
    }
  });
}

function normalizeDraft(value) {
  const title = String(value.title ?? "").trim();
  if (!title || title.length > 120) throw new MixValidationError("Mix title must be between 1 and 120 characters.");
  if (!Array.isArray(value.trackIds)) throw new MixValidationError("Mix tracks are required.");
  const crossfadeSeconds = validateCrossfade(value.crossfadeSeconds ?? DEFAULT_CROSSFADE_SECONDS);
  return { id: value.id, title, trackIds: [...value.trackIds], crossfadeSeconds, transitions: buildTransitions(value.trackIds, crossfadeSeconds), exports: value.exports ?? [], createdAt: value.createdAt, updatedAt: value.updatedAt };
}
function validateCrossfade(value) { const n = Number(value); if (!Number.isFinite(n) || n < 0 || n > 20) throw new MixValidationError("Crossfade must be between 0 and 20 seconds."); return n; }
function approvalSnapshot(mix, tracks, transitions, summary) { return crypto.createHash("sha256").update(JSON.stringify({ id: mix.id, title: mix.title, updatedAt: mix.updatedAt, tracks: tracks.map((t) => ({ id: t.id, filename: t.filename, duration: t.duration, size: t.size, mtimeMs: t.mtimeMs })), transitions, summary })).digest("hex"); }
function isStoredMix(mix) { return mix && typeof mix.id === "string" && typeof mix.title === "string" && Array.isArray(mix.trackIds) && Array.isArray(mix.transitions) && Array.isArray(mix.exports) && typeof mix.updatedAt === "string"; }
function safeFilename(filename, extension) { return typeof filename === "string" && filename.length <= 180 && path.basename(filename) === filename && path.extname(filename).toLowerCase() === extension && !filename.startsWith(".") && !/[<>:"/\\|?*\x00-\x1f]/.test(filename); }
function safeChild(directory, filename, extension) { if (!safeFilename(filename, extension)) throw new MixValidationError("Invalid media filename."); const resolved = path.resolve(directory, filename); if (path.dirname(resolved) !== path.resolve(directory)) throw new MixValidationError("Media path must remain inside its designated directory."); return resolved; }
async function exists(statFn, filePath) { try { await statFn(filePath); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function assertFile(statFn, filePath) { try { const info = await statFn(filePath); if (!info.isFile() || info.size <= 0) throw new Error(); } catch { throw new MixValidationError("A selected source recording is missing or invalid."); } }
function slug(value) { return String(value).normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 150); }
export function formatDuration(seconds) { const rounded = Math.round(seconds); return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`; }

export class MixValidationError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class MixNotFoundError extends Error { constructor() { super("Audio mix not found."); this.statusCode = 404; } }
export class MixConflictError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class MixUnavailableError extends Error { constructor(message) { super(message); this.statusCode = 503; } }
export class MixRenderError extends Error { constructor(message) { super(message); this.statusCode = 500; } }
