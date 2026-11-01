import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";

export const REVIEW_STATUSES = ["Unreviewed", "Keep", "Reject"];
const LIBRARY_VERSION = 1;
const METADATA_FILENAME = "library.json";
const IMPORTED_PROMPT = "Original prompt unavailable (imported existing MP3).";

export class TrackLibrary {
  constructor(outputDirectory, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.metadataPath = path.join(this.outputDirectory, METADATA_FILENAME);
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir,
      readFile: dependencies.readFile ?? readFile,
      readdir: dependencies.readdir ?? readdir,
      rename: dependencies.rename ?? rename,
      rm: dependencies.rm ?? rm,
      stat: dependencies.stat ?? stat,
      writeFile: dependencies.writeFile ?? writeFile,
    };
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.data = { version: LIBRARY_VERSION, tracks: [] };
    this.queue = Promise.resolve();
  }

  initialize() {
    return this.#exclusive(async () => {
      await this.fs.mkdir(this.outputDirectory, { recursive: true });
      this.data = await this.#readMetadata();
      const changed = await this.#importUnregisteredMp3s();
      if (changed) await this.#persist();
      return this.#snapshot();
    });
  }

  list() {
    return this.#snapshot();
  }

  registerGenerated({ filename, prompt, title }) {
    return this.#exclusive(async () => {
      this.#resolveMp3Path(filename);
      const existing = this.data.tracks.find((track) => sameFilename(track.filename, filename));
      if (existing) return structuredClone(existing);

      const track = this.#createTrack({
        filename,
        title: normalizeTitle(title) || titleFromFilename(filename),
        prompt: typeof prompt === "string" && prompt.trim() ? prompt.trim() : IMPORTED_PROMPT,
        createdAt: this.now().toISOString(),
      });
      this.data.tracks.push(track);
      await this.#persist();
      return structuredClone(track);
    });
  }

  update(id, changes) {
    return this.#exclusive(async () => {
      const track = this.#findTrack(id);
      if (Object.hasOwn(changes, "title")) {
        const title = normalizeTitle(changes.title);
        if (!title) throw new LibraryValidationError("Title must be between 1 and 120 characters.");
        track.title = title;
      }
      if (Object.hasOwn(changes, "reviewStatus")) {
        if (!REVIEW_STATUSES.includes(changes.reviewStatus)) {
          throw new LibraryValidationError(`Review status must be one of: ${REVIEW_STATUSES.join(", ")}.`);
        }
        track.reviewStatus = changes.reviewStatus;
      }
      await this.#persist();
      return structuredClone(track);
    });
  }

  delete(id) {
    return this.#exclusive(async () => {
      const index = this.data.tracks.findIndex((track) => track.id === id);
      if (index < 0) throw new TrackNotFoundError();
      const track = this.data.tracks[index];
      const audioPath = this.#resolveMp3Path(track.filename);

      await this.fs.rm(audioPath, { force: true });
      this.data.tracks.splice(index, 1);
      await this.#persist();
      return structuredClone(track);
    });
  }

  #exclusive(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async #readMetadata() {
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.metadataPath, "utf8"));
      if (parsed?.version !== LIBRARY_VERSION || !Array.isArray(parsed.tracks)) {
        throw new Error("Unsupported library metadata format.");
      }
      return {
        version: LIBRARY_VERSION,
        tracks: parsed.tracks.filter(isValidStoredTrack).map((track) => ({ ...track })),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: LIBRARY_VERSION, tracks: [] };
      throw new Error(`Could not read ${METADATA_FILENAME}: ${error.message}`);
    }
  }

  async #importUnregisteredMp3s() {
    const entries = await this.fs.readdir(this.outputDirectory, { withFileTypes: true });
    let changed = false;
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".mp3") continue;
      if (this.data.tracks.some((track) => sameFilename(track.filename, entry.name))) continue;

      const audioPath = this.#resolveMp3Path(entry.name);
      const fileStat = await this.fs.stat(audioPath);
      this.data.tracks.push(this.#createTrack({
        filename: entry.name,
        title: titleFromFilename(entry.name),
        prompt: IMPORTED_PROMPT,
        createdAt: (fileStat.birthtimeMs > 0 ? fileStat.birthtime : fileStat.mtime).toISOString(),
      }));
      changed = true;
    }
    return changed;
  }

  #createTrack({ filename, title, prompt, createdAt }) {
    return {
      id: this.randomUUID(),
      filename,
      title,
      prompt,
      createdAt,
      reviewStatus: "Unreviewed",
    };
  }

  #findTrack(id) {
    const track = this.data.tracks.find((candidate) => candidate.id === id);
    if (!track) throw new TrackNotFoundError();
    return track;
  }

  #resolveMp3Path(filename) {
    if (typeof filename !== "string" || path.basename(filename) !== filename || path.extname(filename).toLowerCase() !== ".mp3") {
      throw new LibraryValidationError("Invalid MP3 filename.");
    }
    const resolved = path.resolve(this.outputDirectory, filename);
    if (path.dirname(resolved) !== this.outputDirectory) {
      throw new LibraryValidationError("MP3 path must stay inside the output directory.");
    }
    return resolved;
  }

  async #persist() {
    const temporaryPath = path.join(this.outputDirectory, `.${METADATA_FILENAME}.${this.randomUUID()}.tmp`);
    const json = `${JSON.stringify(this.data, null, 2)}\n`;
    try {
      await this.fs.writeFile(temporaryPath, json, { encoding: "utf8", flag: "wx" });
      await this.fs.rename(temporaryPath, this.metadataPath);
    } catch (error) {
      await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  #snapshot() {
    return structuredClone(this.data.tracks).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

function normalizeTitle(value) {
  if (typeof value !== "string") return "";
  const title = value.trim();
  return title.length >= 1 && title.length <= 120 ? title : "";
}

function titleFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const title = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return title || "Untitled track";
}

function sameFilename(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function isValidStoredTrack(track) {
  return track && typeof track.id === "string" && typeof track.filename === "string"
    && typeof track.title === "string" && typeof track.prompt === "string"
    && typeof track.createdAt === "string" && REVIEW_STATUSES.includes(track.reviewStatus);
}

export class LibraryValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

export class TrackNotFoundError extends Error {
  constructor() {
    super("Track not found.");
    this.statusCode = 404;
  }
}
