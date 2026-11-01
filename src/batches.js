import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { assertGenerationSnapshot, ProjectConflictError, ProjectValidationError } from "./projects.js";

export const MAX_BATCH_SIZE = 5;
const BATCHES_FILENAME = "batches.json";
const ACTIVE_STATUSES = new Set(["approved", "running", "stopping"]);

export class BatchStore {
  constructor(outputDirectory, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.filePath = path.join(this.outputDirectory, BATCHES_FILENAME);
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir,
      readFile: dependencies.readFile ?? readFile,
      rename: dependencies.rename ?? rename,
      rm: dependencies.rm ?? rm,
      writeFile: dependencies.writeFile ?? writeFile,
    };
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.data = { version: 1, batches: [] };
    this.queue = Promise.resolve();
  }

  initialize() {
    return this.#exclusive(async () => {
      await this.fs.mkdir(this.outputDirectory, { recursive: true });
      try {
        const parsed = JSON.parse(await this.fs.readFile(this.filePath, "utf8"));
        if (parsed?.version !== 1 || !Array.isArray(parsed.batches)) throw new Error("Unsupported batch metadata format.");
        this.data = { version: 1, batches: parsed.batches.filter(isStoredBatch) };
      } catch (error) {
        if (error?.code !== "ENOENT") throw new Error(`Could not read ${BATCHES_FILENAME}: ${error.message}`);
      }

      let changed = false;
      for (const batch of this.data.batches) {
        if (ACTIVE_STATUSES.has(batch.status)) {
          batch.status = "interrupted";
          batch.stopRequested = true;
          batch.finishedAt = this.now().toISOString();
          batch.failure = "The server stopped before this batch finished. It will not resume automatically. Review saved tracks before starting another batch.";
          changed = true;
        }
      }
      if (changed) await this.#persist();
      return this.list();
    });
  }

  list() {
    return structuredClone(this.data.batches).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    const batch = this.data.batches.find((candidate) => candidate.id === id);
    if (!batch) throw new BatchNotFoundError();
    return structuredClone(batch);
  }

  active() {
    const batch = this.data.batches.find((candidate) => ACTIVE_STATUSES.has(candidate.status));
    return batch ? structuredClone(batch) : undefined;
  }

  create(approval) {
    return this.#exclusive(async () => {
      if (this.data.batches.some((batch) => ACTIVE_STATUSES.has(batch.status))) {
        throw new BatchConflictError("A batch is already active. Wait for it to finish or stop it first.");
      }
      const now = this.now().toISOString();
      const batch = {
        id: this.randomUUID(),
        projectId: approval.projectId,
        projectName: approval.projectName,
        tracks: structuredClone(approval.tracks),
        authorizedRequestCount: approval.tracks.length,
        requestsStarted: 0,
        completed: [],
        status: "approved",
        stopRequested: false,
        createdAt: now,
        updatedAt: now,
      };
      await this.#mutateAndPersist((next) => next.batches.push(batch));
      return structuredClone(batch);
    });
  }

  update(id, mutate) {
    return this.#exclusive(async () => {
      if (!this.data.batches.some((candidate) => candidate.id === id)) throw new BatchNotFoundError();
      await this.#mutateAndPersist((next) => {
        const batch = next.batches.find((candidate) => candidate.id === id);
        mutate(batch);
        batch.updatedAt = this.now().toISOString();
      });
      return this.get(id);
    });
  }

  requestStop(id) {
    return this.update(id, (batch) => {
      if (!ACTIVE_STATUSES.has(batch.status)) throw new BatchConflictError("This batch is no longer active.");
      batch.stopRequested = true;
      if (batch.status !== "approved") batch.status = "stopping";
    });
  }

  async #mutateAndPersist(mutate) {
    const next = structuredClone(this.data);
    mutate(next);
    await this.#persist(next);
    this.data = next;
  }

  async #persist(data = this.data) {
    const temporaryPath = path.join(this.outputDirectory, `.batches.${this.randomUUID()}.tmp`);
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await this.#renameWithWindowsContentionRetry(temporaryPath, this.filePath);
    } catch (error) {
      await this.fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #renameWithWindowsContentionRetry(source, destination) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.fs.rename(source, destination);
      } catch (error) {
        if (!["EPERM", "EBUSY"].includes(error?.code) || attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }

  #exclusive(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}

export class BatchCoordinator {
  constructor({ store, projects, generateTrack, logger = console, diagnoseError = safeError }) {
    this.store = store;
    this.projects = projects;
    this.generateTrack = generateTrack;
    this.logger = logger;
    this.diagnoseError = diagnoseError;
    this.running = new Set();
  }

  hasActive() {
    return Boolean(this.store.active());
  }

  list() {
    return this.store.list();
  }

  get(id) {
    return this.store.get(id);
  }

  async start(projectId, expected) {
    const approval = validateBatchApproval(this.projects.list(), projectId, expected);
    const batch = await this.store.create(approval);
    this.running.add(batch.id);
    queueMicrotask(() => this.#run(batch.id).catch((error) => {
      this.logger.error("Batch runner terminated unexpectedly:", this.diagnoseError(error));
    }));
    return batch;
  }

  stop(id) {
    return this.store.requestStop(id);
  }

  async #run(id) {
    try {
      let batch = await this.store.update(id, (current) => {
        if (current.stopRequested) {
          current.status = "stopped";
          current.finishedAt = new Date().toISOString();
        } else {
          current.status = "running";
        }
      });
      if (batch.status === "stopped") return;

      for (const approvedTrack of batch.tracks) {
        batch = this.store.get(id);
        if (batch.stopRequested) {
          await this.#finishStopped(id);
          return;
        }
        if (batch.requestsStarted >= batch.authorizedRequestCount || batch.requestsStarted >= MAX_BATCH_SIZE) {
          await this.#fail(id, "The server request limit was reached before the batch completed.", true);
          return;
        }

        try {
          const { track } = this.projects.getTrack(batch.projectId, approvedTrack.id);
          if (track.status !== "Pending") throw new ProjectConflictError(`“${approvedTrack.title}” is no longer pending.`);
          assertGenerationSnapshot(track, approvedTrack);
        } catch (error) {
          await this.#fail(id, `Batch stopped before another paid request: ${error.message}`, false);
          return;
        }

        batch = await this.store.update(id, (current) => {
          current.requestsStarted += 1;
          current.currentTrackId = approvedTrack.id;
        });

        try {
          const result = await this.generateTrack(batch.projectId, approvedTrack.id);
          await this.store.update(id, (current) => {
            current.completed.push({
              trackId: approvedTrack.id,
              title: approvedTrack.title,
              filename: result.filename,
              libraryTrackId: result.libraryTrackId,
              completedAt: new Date().toISOString(),
            });
            delete current.currentTrackId;
          });
        } catch (error) {
          this.logger.error("Batch generation stopped (no retry was attempted):", this.diagnoseError(error));
          await this.#fail(id, `Generation of “${approvedTrack.title}” failed. No retry was made and no further requests were started. Review the terminal and saved files before continuing.`, true, approvedTrack.id);
          return;
        }
      }

      batch = this.store.get(id);
      if (batch.stopRequested) await this.#finishStopped(id);
      else await this.store.update(id, (current) => {
        current.status = "completed";
        current.finishedAt = new Date().toISOString();
        delete current.currentTrackId;
      });
    } finally {
      this.running.delete(id);
    }
  }

  #finishStopped(id) {
    return this.store.update(id, (batch) => {
      batch.status = "stopped";
      batch.finishedAt = new Date().toISOString();
      delete batch.currentTrackId;
    });
  }

  #fail(id, message, uncertain, trackId) {
    return this.store.update(id, (batch) => {
      batch.status = "failed";
      batch.failure = message;
      batch.outcomeUncertain = uncertain;
      batch.failedTrackId = trackId;
      batch.finishedAt = new Date().toISOString();
      delete batch.currentTrackId;
    });
  }
}

export function validateBatchApproval(projects, projectId, expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new ProjectConflictError("The batch approval snapshot is missing. Refresh and select the tracks again.");
  }
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new BatchNotFoundError("Project not found.");
  if (expected.projectName !== project.name) {
    throw new ProjectConflictError("The project name changed after approval. Refresh and review the batch again.");
  }
  if (!Array.isArray(expected.tracks) || expected.tracks.length < 1 || expected.tracks.length > MAX_BATCH_SIZE) {
    throw new ProjectValidationError(`Select between 1 and ${MAX_BATCH_SIZE} pending tracks.`);
  }
  const ids = expected.tracks.map((track) => track?.id);
  if (new Set(ids).size !== ids.length) throw new ProjectValidationError("A track may only appear once in a batch.");
  const indexes = ids.map((id) => project.tracks.findIndex((track) => track.id === id));
  if (indexes.some((index) => index < 0) || indexes.some((index, position) => position > 0 && index <= indexes[position - 1])) {
    throw new ProjectConflictError("Selected tracks must still exist in their saved project order.");
  }
  const tracks = expected.tracks.map((snapshot, position) => {
    const track = project.tracks[indexes[position]];
    if (track.status !== "Pending") throw new ProjectConflictError(`“${track.title}” is already generated and cannot be included.`);
    assertGenerationSnapshot(track, snapshot);
    return { id: track.id, title: track.title, direction: track.direction, prompt: track.prompt };
  });
  return { projectId: project.id, projectName: project.name, tracks };
}

function isStoredBatch(batch) {
  const statuses = ["approved", "running", "stopping", "completed", "failed", "stopped", "interrupted"];
  return batch && typeof batch.id === "string" && typeof batch.projectId === "string"
    && typeof batch.projectName === "string" && Array.isArray(batch.tracks)
    && Number.isInteger(batch.authorizedRequestCount) && batch.authorizedRequestCount >= 1
    && batch.authorizedRequestCount <= MAX_BATCH_SIZE && Number.isInteger(batch.requestsStarted)
    && batch.requestsStarted >= 0 && batch.requestsStarted <= batch.authorizedRequestCount
    && Array.isArray(batch.completed) && batch.completed.length <= batch.authorizedRequestCount
    && statuses.includes(batch.status) && typeof batch.createdAt === "string";
}

function safeError(error) {
  return { name: error?.name, message: error?.message, code: error?.code };
}

export class BatchConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "BatchConflictError";
    this.statusCode = 409;
  }
}

export class BatchNotFoundError extends Error {
  constructor(message = "Batch not found.") {
    super(message);
    this.name = "BatchNotFoundError";
    this.statusCode = 404;
  }
}
