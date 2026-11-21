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
      assignPlanningMetadata(project, validated);
      if (sourcePlan) project.sourcePlan = validateSourcePlan(sourcePlan);
      return this.#mutateAndPersist(() => this.data.projects.push(project), project);
    });
  }

  previewFileImport(payload, filename) {
    const validated = validateImport(payload); const safeFilename = validateImportFilename(filename); const fingerprint = importFingerprint(validated);
    if (this.data.projects.some((project) => project.fileImport?.fingerprint === fingerprint)) throw new ProjectConflictError("This exact project plan has already been imported.");
    const warnings = [];
    if (!validated.targetDurationMinutes) warnings.push("No planned compilation duration was supplied.");
    else if (validated.targetDurationMinutes < 62) warnings.push("The planned target is below the recommended 62-minute source-material buffer; rendering still depends on actual accepted recordings and final duration.");
    if (validated.tracks.some((track) => !track.energy)) warnings.push("Some tracks do not include an energy classification.");
    const energyDistribution = { high: 0, moderate: 0, low: 0 };
    for (const track of validated.tracks) if (track.energy) energyDistribution[track.energy] += 1;
    const preview = { filename: safeFilename, fingerprint, plan: validated, trackCount: validated.tracks.length, energyDistribution, warnings };
    return { ...preview, snapshot: crypto.createHash("sha256").update(JSON.stringify(preview)).digest("hex") };
  }

  importFile(payload, approval) {
    return this.#exclusive(async () => {
      const preview = this.previewFileImport(payload, approval?.filename);
      if (preview.snapshot !== approval?.snapshot) throw new ProjectConflictError("The project plan changed after preview. Review and confirm it again.");
      const project = { id: this.randomUUID(), name: preview.plan.name, theme: preview.plan.theme, createdAt: this.now().toISOString(), tracks: preview.plan.tracks.map((track) => this.#newTrack(track)), fileImport: { filename: preview.filename, fingerprint: preview.fingerprint, importedAt: this.now().toISOString() } };
      assignPlanningMetadata(project, preview.plan);
      return this.#mutateAndPersist(() => this.data.projects.push(project), project);
    });
  }

  exportPlan(projectId) {
    const project = this.#findProject(projectId);
    const result = { version: PROJECT_IMPORT_VERSION, name: project.name, theme: project.theme };
    for (const field of ["thematicOpening", "genres", "moods", "targetDurationMinutes", "arrangementNotes"]) if (project[field] !== undefined) result[field] = structuredClone(project[field]);
    result.tracks = project.tracks.map((track, index) => {
      const exported = { title: track.title, direction: track.direction, prompt: track.prompt };
      for (const field of ["identifier", "energy", "tempo", "musicalKey", "arrangementNotes"]) if (track[field] !== undefined) exported[field] = structuredClone(track[field]);
      exported.position = index + 1;
      return exported;
    });
    return result;
  }

  update(projectId, changes) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      const updated = { ...project };
      if (Object.hasOwn(changes, "name")) updated.name = validateText(changes.name, "Project name", 1, 100);
      if (Object.hasOwn(changes, "theme")) updated.theme = validateText(changes.theme, "Project theme", 1, 2000);
      if (Object.hasOwn(changes, "thematicOpening")) assignOptionalOpening(updated, changes.thematicOpening);
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
      const fields = Object.keys(changes ?? {}); const openingOnly = fields.length === 1 && fields[0] === "thematicOpening";
      if (track.status === "Generated" && !openingOnly) throw new ProjectValidationError("Generated planned tracks cannot be edited except for their YouTube thematic opening.");
      const updated = { ...track };
      if (Object.hasOwn(changes, "title")) updated.title = validateText(changes.title, "Track title", 1, 120);
      if (Object.hasOwn(changes, "direction")) updated.direction = validateText(changes.direction, "Musical direction", 1, 1000);
      if (Object.hasOwn(changes, "prompt")) updated.prompt = validateText(changes.prompt, "Generation prompt", 10, 2000);
      if (Object.hasOwn(changes, "thematicOpening")) assignOptionalOpening(updated, changes.thematicOpening);
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

  repairLegacyLinks(projectId, repairs, expectedProject) {
    return this.#exclusive(async () => {
      const project = this.#findProject(projectId);
      if (JSON.stringify(project) !== JSON.stringify(expectedProject)) throw new ProjectConflictError("The project changed after the legacy-link repair was reviewed. Review it again.");
      if (!Array.isArray(repairs) || !repairs.length) throw new ProjectValidationError("No legacy recording links were selected for repair.");
      const ids = new Set();
      for (const repair of repairs) {
        if (!repair || typeof repair.plannedTrackId !== "string" || typeof repair.libraryTrackId !== "string" || ids.has(repair.libraryTrackId)) throw new ProjectValidationError("Legacy recording-link repair data is invalid.");
        ids.add(repair.libraryTrackId); const track = project.tracks.find((candidate) => candidate.id === repair.plannedTrackId);
        if (!track) throw new ProjectConflictError("A planned track selected for repair no longer exists.");
        if (track.libraryTrackId && track.libraryTrackId !== repair.libraryTrackId) throw new ProjectConflictError("A planned track is already linked to a different recording. Nothing was changed.");
      }
      return this.#mutateAndPersist(() => {
        for (const repair of repairs) { const track = project.tracks.find((candidate) => candidate.id === repair.plannedTrackId); track.status = "Generated"; track.libraryTrackId = repair.libraryTrackId; }
      }, project);
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
    const track = {
      id: this.randomUUID(),
      title: validateText(values.title, "Track title", 1, 120),
      direction: validateText(values.direction, "Musical direction", 1, 1000),
      prompt: validateText(values.prompt, "Generation prompt", 10, 2000),
      status: "Pending",
    };
    for (const field of ["identifier", "energy", "tempo", "musicalKey", "arrangementNotes"]) if (values[field] !== undefined) track[field] = structuredClone(values[field]);
    return track;
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
  rejectUnknownFields(payload, ["version", "name", "theme", "thematicOpening", "genres", "moods", "targetDurationMinutes", "arrangementNotes", "tracks"], "Project");
  if (payload.version !== PROJECT_IMPORT_VERSION) throw new ProjectValidationError(`Import version must be ${PROJECT_IMPORT_VERSION}.`);
  if (!Array.isArray(payload.tracks) || payload.tracks.length < 1 || payload.tracks.length > MAX_PROJECT_TRACKS) {
    throw new ProjectValidationError(`Import must contain between 1 and ${MAX_PROJECT_TRACKS} tracks.`);
  }
  const result = {
    version: PROJECT_IMPORT_VERSION,
    name: validateText(payload.name, "Project name", 1, 100),
    theme: validateText(payload.theme, "Project theme", 1, 2000),
    tracks: payload.tracks.map((track, index) => {
      if (!track || typeof track !== "object" || Array.isArray(track)) throw new ProjectValidationError(`Track ${index + 1} must be an object.`);
      rejectUnknownFields(track, ["identifier", "title", "direction", "prompt", "energy", "tempo", "musicalKey", "position", "arrangementNotes"], `Track ${index + 1}`);
      const item = {
        title: validateText(track.title, `Track ${index + 1} title`, 1, 120),
        direction: validateText(track.direction, `Track ${index + 1} direction`, 1, 1000),
        prompt: validateText(track.prompt, `Track ${index + 1} prompt`, 10, 2000),
      };
      if (track.identifier !== undefined) item.identifier = validateIdentifier(track.identifier, index);
      if (track.energy !== undefined) item.energy = validateEnergy(track.energy, index);
      if (track.tempo !== undefined) item.tempo = validateTempo(track.tempo, index);
      if (track.musicalKey !== undefined) item.musicalKey = validateText(track.musicalKey, `Track ${index + 1} musical key`, 1, 40);
      if (track.position !== undefined) item.position = validatePosition(track.position, index);
      if (track.arrangementNotes !== undefined) item.arrangementNotes = validateText(track.arrangementNotes, `Track ${index + 1} arrangement notes`, 1, 1000);
      return item;
    }),
  };
  if (payload.thematicOpening !== undefined) assignOptionalOpening(result, payload.thematicOpening);
  if (payload.genres !== undefined) result.genres = validateDescriptors(payload.genres, "Genre descriptors");
  if (payload.moods !== undefined) result.moods = validateDescriptors(payload.moods, "Mood descriptors");
  if (payload.targetDurationMinutes !== undefined) result.targetDurationMinutes = validateDurationTarget(payload.targetDurationMinutes);
  if (payload.arrangementNotes !== undefined) result.arrangementNotes = validateText(payload.arrangementNotes, "Arrangement notes", 1, 2000);
  const identifiers = result.tracks.map((track) => track.identifier).filter(Boolean); if (new Set(identifiers).size !== identifiers.length) throw new ProjectValidationError("Track identifiers must be unique.");
  const positions = result.tracks.map((track) => track.position); if (positions.some((value) => value !== undefined) && positions.some((value) => value === undefined)) throw new ProjectValidationError("Every track must include a position when any explicit position is used.");
  if (positions.some((value, index) => value !== undefined && value !== index + 1)) throw new ProjectValidationError("Track positions must be consecutive and match the JSON track order, starting at 1.");
  return result;
}

export function importFingerprint(validated) { return crypto.createHash("sha256").update(JSON.stringify(validated)).digest("hex"); }

export function validateImportFilename(value) {
  if (typeof value !== "string" || value !== path.basename(value) || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.json$/i.test(value)) throw new ProjectValidationError("Import filename must be a safe local .json filename.");
  return value;
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

function validateDescriptors(value, label) { if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new ProjectValidationError(`${label} must contain between 1 and 20 entries.`); return value.map((item, index) => validateText(item, `${label} entry ${index + 1}`, 1, 80)); }
function validateDurationTarget(value) { if (!Number.isFinite(value) || value < 1 || value > 1440) throw new ProjectValidationError("Intended compilation duration must be between 1 and 1440 minutes."); return value; }
function validateIdentifier(value, index) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new ProjectValidationError(`Track ${index + 1} identifier is invalid.`); return value; }
function validateEnergy(value, index) { if (!["high", "moderate", "low"].includes(value)) throw new ProjectValidationError(`Track ${index + 1} energy must be high, moderate, or low.`); return value; }
function validatePosition(value, index) { if (!Number.isInteger(value) || value < 1 || value > MAX_PROJECT_TRACKS) throw new ProjectValidationError(`Track ${index + 1} position is invalid.`); return value; }
function validateTempo(value, index) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProjectValidationError(`Track ${index + 1} tempo must be an object.`); rejectUnknownFields(value, ["minBpm", "maxBpm"], `Track ${index + 1} tempo`); const minBpm = Number(value.minBpm); const maxBpm = Number(value.maxBpm ?? value.minBpm); if (!Number.isFinite(minBpm) || !Number.isFinite(maxBpm) || minBpm < 20 || maxBpm > 300 || minBpm > maxBpm) throw new ProjectValidationError(`Track ${index + 1} tempo must be between 20 and 300 BPM with minBpm not exceeding maxBpm.`); return { minBpm, maxBpm }; }
function assignPlanningMetadata(project, validated) { for (const field of ["thematicOpening", "genres", "moods", "targetDurationMinutes", "arrangementNotes"]) if (validated[field] !== undefined) project[field] = structuredClone(validated[field]); }

function assignOptionalOpening(target, value) {
  const opening = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!opening) { delete target.thematicOpening; return; }
  if (opening.length > 180) throw new ProjectValidationError("Thematic opening must not exceed 180 characters.");
  if (!/^Music for\s+\S/.test(opening)) throw new ProjectValidationError('Thematic opening must begin with “Music for”.');
  if (!/[.!?]$/.test(opening)) throw new ProjectValidationError("Thematic opening must be a complete sentence ending in punctuation.");
  target.thematicOpening = opening;
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
