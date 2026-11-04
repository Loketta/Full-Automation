import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";

export const PROJECT_IMPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 128 * 1024;
export const MAX_PROJECT_TRACKS = 100;
const PROJECTS_FILENAME = "projects.json";

export class ProjectStore {
  constructor(outputDirectory, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.filePath = path.join(this.outputDirectory, PROJECTS_FILENAME);
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir,
      readFile: dependencies.readFile ?? readFile,
      rename: dependencies.rename ?? rename,
      rm: dependencies.rm ?? rm,
      writeFile: dependencies.writeFile ?? writeFile,
    };
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.data = { version: 1, projects: [] };
    this.queue = Promise.resolve();
  }

  initialize() {
    return this.#exclusive(async () => {
      await this.fs.mkdir(this.outputDirectory, { recursive: true });
      try {
        const parsed = JSON.parse(await this.fs.readFile(this.filePath, "utf8"));
        if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) throw new Error("Unsupported project metadata format.");
        this.data = { version: 1, projects: parsed.projects.filter(isStoredProject) };
      } catch (error) {
        if (error?.code !== "ENOENT") throw new Error(`Could not read ${PROJECTS_FILENAME}: ${error.message}`);
      }
      return this.list();
    });
  }

  list() {
    return structuredClone(this.data.projects);
  }

  get(projectId) {
    return structuredClone(this.#findProject(projectId));
  }

  getTrack(projectId, trackId) {
    const project = this.#findProject(projectId);
    const track = project.tracks.find((candidate) => candidate.id === trackId);
    if (!track) throw new ProjectNotFoundError("Planned track not found.");
    return structuredClone({ project, track });
  }

  create({ name, theme }) {
    return this.#exclusive(async () => {
      const project = {
        id: this.randomUUID(),
        name: validateText(name, "Project name", 1, 100),
        theme: validateText(theme, "Project theme", 1, 2000),
        createdAt: this.now().toISOString(),
        tracks: [],
      };
      return this.#mutateAndPersist(() => this.data.projects.push(project), project);
    });
  }

  import(payload, sourcePlan) {
    const validated = validateImport(payload);
    return this.#exclusive(async () => {
      const project = {
        id: this.randomUUID(),
        name: validated.name,
        theme: validated.theme,
        createdAt: this.now().toISOString(),
        tracks: validated.tracks.map((track) => this.#newTrack(track)),
      };
      if (sourcePlan) project.sourcePlan = validateSourcePlan(sourcePlan);
      return this.#mutateAndPersist(() => this.data.projects.push(project), project);
    });
  }

  update(projectId, changes) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const updated = { ...project };
      if (Object.hasOwn(changes, "name")) updated.name = validateText(changes.name, "Project name", 1, 100);
      if (Object.hasOwn(changes, "theme")) updated.theme = validateText(changes.theme, "Project theme", 1, 2000);
      return this.#mutateAndPersist(() => Object.assign(project, updated), project);
    });
  }

  delete(projectId) {
    return this.#exclusive(async () => {
      const index = this.data.projects.findIndex((project) => project.id === projectId);
      if (index < 0) throw new ProjectNotFoundError();
      const project = this.data.projects[index];
      await this.#mutateAndPersist(() => this.data.projects.splice(index, 1), project);
      return structuredClone(project);
    });
  }

  addTrack(projectId, values) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const track = this.#newTrack(values);
      return this.#mutateAndPersist(() => project.tracks.push(track), track);
    });
  }

  appendPlan(projectId, payload, approval) {
    const validated = validateImport(payload);
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      if (projectStateFingerprint(project) !== approval?.projectSnapshot) {
        throw new ProjectConflictError("The target project changed after the append summary was prepared. Review and confirm it again.");
      }
      const marker = validateAppendMarker(approval);
      if ((project.appendedPlans ?? []).some((entry) => entry.planId === marker.planId && entry.fingerprint === marker.fingerprint)) {
        throw new ProjectConflictError("This exact repository plan version has already been appended to the selected project.");
      }
      if (project.tracks.length + validated.tracks.length > MAX_PROJECT_TRACKS) {
        throw new ProjectValidationError(`A project may contain at most ${MAX_PROJECT_TRACKS} tracks.`);
      }
      const newTracks = validated.tracks.map((track) => this.#newTrack(track));
      await this.#mutateAndPersist(() => {
        project.tracks.push(...newTracks);
        project.appendedPlans = [...(project.appendedPlans ?? []), marker];
      }, project);
      return { project: structuredClone(project), addedTrackIds: newTracks.map((track) => track.id) };
    });
  }

  updateTrack(projectId, trackId, changes) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      if (!track) throw new ProjectNotFoundError("Planned track not found.");
      if (track.status === "Generated") throw new ProjectValidationError("Generated planned tracks cannot be edited.");
      const updated = { ...track };
      if (Object.hasOwn(changes, "title")) updated.title = validateText(changes.title, "Track title", 1, 120);
      if (Object.hasOwn(changes, "direction")) updated.direction = validateText(changes.direction, "Musical direction", 1, 1000);
      if (Object.hasOwn(changes, "prompt")) updated.prompt = validateText(changes.prompt, "Generation prompt", 10, 2000);
      return this.#mutateAndPersist(() => Object.assign(track, updated), track);
    });
  }

  deleteTrack(projectId, trackId) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const index = project.tracks.findIndex((track) => track.id === trackId);
      if (index < 0) throw new ProjectNotFoundError("Planned track not found.");
      const track = project.tracks[index];
      await this.#mutateAndPersist(() => project.tracks.splice(index, 1), track);
      return structuredClone(track);
    });
  }

  linkGenerated(projectId, trackId, libraryTrackId) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      if (!track) throw new ProjectNotFoundError("Planned track not found.");
      track.status = "Generated";
      track.libraryTrackId = libraryTrackId;
      // Keep the in-memory link on write failure so the current session cannot
      // accidentally pay for this track twice. Startup reconciliation repairs disk.
      await this.#persist();
      return structuredClone(track);
    });
  }

  markSavedFile(projectId, trackId, filename) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      if (!track) throw new ProjectNotFoundError("Planned track not found.");
      track.status = "Generated";
      track.recoveryFilename = filename;
      delete track.libraryTrackId;
      await this.#persist();
      return structuredClone(track);
    });
  }

  commitReplacement(projectId, trackId, { oldLibraryTrackId, newLibraryTrackId, prompt }) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      if (!track) throw new ProjectNotFoundError("Planned track not found.");
      if (track.status !== "Generated" || track.libraryTrackId !== oldLibraryTrackId) {
        throw new ProjectConflictError("The recording linked to this planned track changed. Refresh before regenerating.");
      }
      const revisedPrompt = validateText(prompt, "Regeneration prompt", 10, 2000);
      const updated = {
        ...track,
        prompt: revisedPrompt,
        libraryTrackId: newLibraryTrackId,
        replacementCleanupId: oldLibraryTrackId,
      };
      delete updated.recoveryFilename;
      return this.#mutateAndPersist(() => Object.assign(track, updated), track);
    });
  }

  completeReplacementCleanup(projectId, trackId, oldLibraryTrackId) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const track = project.tracks.find((candidate) => candidate.id === trackId);
      if (!track) throw new ProjectNotFoundError("Planned track not found.");
      if (track.replacementCleanupId !== oldLibraryTrackId) return structuredClone(track);
      return this.#mutateAndPersist(() => delete track.replacementCleanupId, track);
    });
  }

  replacementCleanups() {
    const cleanups = [];
    for (const project of this.data.projects) {
      for (const track of project.tracks) {
        if (typeof track.replacementCleanupId === "string") {
          cleanups.push({ projectId: project.id, plannedTrackId: track.id, oldLibraryTrackId: track.replacementCleanupId });
        }
      }
    }
    return structuredClone(cleanups);
  }

  referencesLibraryTrack(libraryTrackId) {
    return this.data.projects.some((project) => project.tracks.some((track) => track.libraryTrackId === libraryTrackId));
  }

  reconcileLibraryLinks(libraryTracks) {
    return this.#exclusive(async () => {
      const byId = new Map(libraryTracks.map((track) => [track.id, track]));
      const preparedTrackKeys = new Set(libraryTracks
        .filter((track) => track.replacementForLibraryTrackId && track.projectId && track.plannedTrackId)
        .map((track) => `${track.projectId}:${track.plannedTrackId}`));
      let changed = false;
      for (const project of this.data.projects) {
        for (const track of project.tracks) {
          // Replacement markers are transaction evidence, not ordinary links.
          // Startup recovery must resolve them before generic reconciliation may
          // relink or downgrade the planned track.
          if (track.replacementCleanupId || preparedTrackKeys.has(`${project.id}:${track.id}`)) continue;
          const current = track.libraryTrackId ? byId.get(track.libraryTrackId) : undefined;
          const associated = current ?? libraryTracks.find((libraryTrack) =>
            libraryTrack.projectId === project.id && libraryTrack.plannedTrackId === track.id);
          const recovered = track.recoveryFilename
            ? libraryTracks.find((libraryTrack) => libraryTrack.filename === track.recoveryFilename)
            : undefined;
          const linked = associated ?? recovered;
          if (linked && (track.status !== "Generated" || track.libraryTrackId !== linked.id || track.recoveryFilename)) {
            track.status = "Generated";
            track.libraryTrackId = linked.id;
            delete track.recoveryFilename;
            changed = true;
          } else if (track.status === "Generated" && track.libraryTrackId && !byId.has(track.libraryTrackId)) {
            track.status = "Pending";
            delete track.libraryTrackId;
            changed = true;
          }
        }
      }
      if (changed) await this.#persist();
      return this.list();
    });
  }

  #newTrack(values) {
    return {
      id: this.randomUUID(),
      title: validateText(values.title, "Track title", 1, 120),
      direction: validateText(values.direction, "Musical direction", 1, 1000),
      prompt: validateText(values.prompt, "Generation prompt", 10, 2000),
      status: "Pending",
    };
  }

  #findProject(id) {
    const project = this.data.projects.find((candidate) => candidate.id === id);
    if (!project) throw new ProjectNotFoundError();
    return project;
  }

  async #mutateAndPersist(mutate, result) {
    const before = structuredClone(this.data);
    mutate();
    try {
      await this.#persist();
      return structuredClone(result);
    } catch (error) {
      this.data = before;
      throw error;
    }
  }

  async #persist() {
    const temporaryPath = path.join(this.outputDirectory, `.projects.${this.randomUUID()}.tmp`);
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await this.fs.rename(temporaryPath, this.filePath);
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

export function validateImport(payload) {
  const bytes = Buffer.byteLength(JSON.stringify(payload ?? null), "utf8");
  if (bytes > MAX_IMPORT_BYTES) throw new ProjectValidationError(`Import must be ${MAX_IMPORT_BYTES / 1024} KB or smaller.`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new ProjectValidationError("Import must be a JSON object.");
  rejectUnknownFields(payload, ["version", "name", "theme", "tracks"], "Project");
  if (payload.version !== PROJECT_IMPORT_VERSION) throw new ProjectValidationError(`Import version must be ${PROJECT_IMPORT_VERSION}.`);
  if (!Array.isArray(payload.tracks) || payload.tracks.length < 1 || payload.tracks.length > MAX_PROJECT_TRACKS) {
    throw new ProjectValidationError(`Import must contain between 1 and ${MAX_PROJECT_TRACKS} tracks.`);
  }
  return {
    version: PROJECT_IMPORT_VERSION,
    name: validateText(payload.name, "Project name", 1, 100),
    theme: validateText(payload.theme, "Project theme", 1, 2000),
    tracks: payload.tracks.map((track, index) => {
      if (!track || typeof track !== "object" || Array.isArray(track)) throw new ProjectValidationError(`Track ${index + 1} must be an object.`);
      rejectUnknownFields(track, ["title", "direction", "prompt"], `Track ${index + 1}`);
      return {
        title: validateText(track.title, `Track ${index + 1} title`, 1, 120),
        direction: validateText(track.direction, `Track ${index + 1} direction`, 1, 1000),
        prompt: validateText(track.prompt, `Track ${index + 1} prompt`, 10, 2000),
      };
    }),
  };
}

export function assertGenerationSnapshot(track, expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new ProjectConflictError("The saved track could not be verified. Refresh the project before generating.");
  }
  const fields = ["title", "direction", "prompt"];
  const matches = fields.every((field) => typeof expected[field] === "string" && expected[field] === track[field]);
  if (!matches) {
    throw new ProjectConflictError("This planned track changed after it was displayed. Refresh and review the saved title and prompt before generating.");
  }
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ProjectValidationError(`${label} contains unsupported field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
}

function validateText(value, label, minimum, maximum) {
  if (typeof value !== "string") throw new ProjectValidationError(`${label} is required.`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) {
    throw new ProjectValidationError(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return text;
}

function validateSourcePlan(sourcePlan) {
  if (!sourcePlan || typeof sourcePlan.id !== "string" || typeof sourcePlan.fingerprint !== "string"
    || !sourcePlan.id || !/^[a-f0-9]{64}$/.test(sourcePlan.fingerprint)) {
    throw new ProjectValidationError("Repository plan provenance is invalid.");
  }
  return { id: sourcePlan.id, fingerprint: sourcePlan.fingerprint };
}

function validateAppendMarker(value) {
  if (!value || typeof value.planId !== "string" || typeof value.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(value.fingerprint) || typeof value.appendedAt !== "string") {
    throw new ProjectValidationError("Repository plan append metadata is invalid.");
  }
  return { planId: value.planId, fingerprint: value.fingerprint, appendedAt: value.appendedAt };
}

export function projectStateFingerprint(project) {
  return crypto.createHash("sha256").update(JSON.stringify(project)).digest("hex");
}

function isStoredProject(project) {
  return project && typeof project.id === "string" && typeof project.name === "string"
    && typeof project.theme === "string" && typeof project.createdAt === "string"
    && Array.isArray(project.tracks) && project.tracks.every((track) =>
      track && typeof track.id === "string" && typeof track.title === "string"
      && typeof track.direction === "string" && typeof track.prompt === "string"
      && ["Pending", "Generated"].includes(track.status)
      && (track.status !== "Generated" || typeof track.libraryTrackId === "string" || typeof track.recoveryFilename === "string"));
}

export class ProjectValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectValidationError";
    this.statusCode = 400;
  }
}

export class ProjectNotFoundError extends Error {
  constructor(message = "Project not found.") {
    super(message);
    this.name = "ProjectNotFoundError";
    this.statusCode = 404;
  }
}

export class ProjectConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectConflictError";
    this.statusCode = 409;
  }
}
