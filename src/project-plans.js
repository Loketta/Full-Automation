import crypto from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { MAX_IMPORT_BYTES, MAX_PROJECT_TRACKS, ProjectConflictError, ProjectNotFoundError, ProjectValidationError, projectStateFingerprint, validateImport } from "./projects.js";

const HISTORY_FILENAME = "project-plan-imports.json";

export class ProjectPlanService {
  constructor(plansDirectory, outputDirectory, projects, dependencies = {}) {
    this.plansDirectory = path.resolve(plansDirectory);
    this.outputDirectory = path.resolve(outputDirectory);
    this.historyPath = path.join(this.outputDirectory, HISTORY_FILENAME);
    this.projects = projects;
    this.fs = {
      mkdir: dependencies.mkdir ?? mkdir, open: dependencies.open ?? open,
      readFile: dependencies.readFile ?? readFile, readdir: dependencies.readdir ?? readdir,
      realpath: dependencies.realpath ?? realpath, rename: dependencies.rename ?? rename,
      rm: dependencies.rm ?? rm, writeFile: dependencies.writeFile ?? writeFile,
    };
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
    this.now = dependencies.now ?? (() => new Date());
    this.history = { version: 1, imports: [] };
    this.queue = Promise.resolve();
  }

  async initialize() {
    await this.fs.mkdir(this.plansDirectory, { recursive: true });
    await this.fs.mkdir(this.outputDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.historyPath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.imports)) throw new Error("Unsupported project plan import history format.");
      this.history = { version: 1, imports: parsed.imports.filter(isHistoryEntry) };
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Could not read project plan import history: ${error.message}`);
    }
  }

  async list() {
    const discovered = await this.#discover();
    return discovered.map((plan) => this.#publicPlan(plan));
  }

  import(planId) {
    return this.#exclusive(async () => {
      assertSafePlanId(planId);
      const plan = (await this.#discover()).find((candidate) => candidate.id === planId);
      if (!plan) throw new ProjectNotFoundError("Repository project plan not found.");
      if (!plan.valid) throw new ProjectValidationError(plan.error);
      const duplicate = this.projects.list().find((project) => project.sourcePlan?.id === plan.id && project.sourcePlan?.fingerprint === plan.fingerprint);
      if (duplicate) throw new ProjectConflictError("This exact repository plan version has already been imported.");

      const project = await this.projects.import(plan.payload, { id: plan.id, fingerprint: plan.fingerprint });
      await this.#recordImport({ planId: plan.id, fingerprint: plan.fingerprint, projectId: project.id, importedAt: this.now().toISOString() });
      return project;
    });
  }

  prepareAppend(planId, targetProjectId) {
    return this.#exclusive(async () => {
      const plan = await this.#validPlan(planId);
      const project = this.projects.list().find((candidate) => candidate.id === targetProjectId);
      if (!project) throw new ProjectNotFoundError("Target project not found.");
      this.#assertAppendAllowed(project, plan);
      return {
        planId: plan.id, planName: plan.payload.name, planFingerprint: plan.fingerprint,
        targetProjectId: project.id, targetProjectName: project.name,
        trackCount: plan.payload.tracks.length, existingTrackCount: project.tracks.length,
        projectSnapshot: projectStateFingerprint(project),
        revised: (project.appendedPlans ?? []).some((entry) => entry.planId === plan.id && entry.fingerprint !== plan.fingerprint),
      };
    });
  }

  append(planId, approval) {
    return this.#exclusive(async () => {
      const plan = await this.#validPlan(planId);
      if (approval?.planFingerprint !== plan.fingerprint) {
        throw new ProjectConflictError("The repository plan changed after the append summary was prepared. Review and confirm the current version.");
      }
      const project = this.projects.list().find((candidate) => candidate.id === approval?.targetProjectId);
      if (!project) throw new ProjectNotFoundError("Target project not found.");
      this.#assertAppendAllowed(project, plan);
      const appendedAt = this.now().toISOString();
      const result = await this.projects.appendPlan(project.id, plan.payload, {
        planId: plan.id, fingerprint: plan.fingerprint, appendedAt, projectSnapshot: approval?.projectSnapshot,
      });
      await this.#recordImport({
        operation: "append", planId: plan.id, fingerprint: plan.fingerprint,
        projectId: project.id, targetProjectId: project.id, addedTrackIds: result.addedTrackIds, importedAt: appendedAt,
      });
      return result.project;
    });
  }

  async #validPlan(planId) {
    assertSafePlanId(planId);
    const plan = (await this.#discover()).find((candidate) => candidate.id === planId);
    if (!plan) throw new ProjectNotFoundError("Repository project plan not found.");
    if (!plan.valid) throw new ProjectValidationError(plan.error);
    return plan;
  }

  #assertAppendAllowed(project, plan) {
    if ((project.appendedPlans ?? []).some((entry) => entry.planId === plan.id && entry.fingerprint === plan.fingerprint)) {
      throw new ProjectConflictError("This exact repository plan version has already been appended to the selected project.");
    }
    if (project.tracks.length + plan.payload.tracks.length > MAX_PROJECT_TRACKS) {
      throw new ProjectValidationError(`Appending this plan would exceed the ${MAX_PROJECT_TRACKS}-track project limit.`);
    }
  }

  async #discover() {
    const directoryRealPath = await this.fs.realpath(this.plansDirectory);
    if (path.resolve(directoryRealPath) !== this.plansDirectory) throw new ProjectValidationError("The project-plans directory cannot be a symbolic link.");
    const entries = await this.fs.readdir(this.plansDirectory, { withFileTypes: true });
    const jsonEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
    const plans = [];
    for (const entry of jsonEntries) {
      if (!safePlanId(entry.name)) {
        plans.push(invalidPlan(entry.name, "Plan filename is unsafe.")); continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        plans.push(invalidPlan(entry.name, "Plan must be a regular JSON file and cannot be a symbolic link.")); continue;
      }
      try {
        const candidatePath = path.join(this.plansDirectory, entry.name);
        const resolved = await this.fs.realpath(candidatePath);
        if (path.dirname(resolved) !== directoryRealPath) throw new ProjectValidationError("Plan must remain directly inside the project-plans directory.");
        const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
        const handle = await this.fs.open(resolved, flags);
        let bytes;
        try {
          const details = await handle.stat();
          if (!details.isFile()) throw new ProjectValidationError("Plan must be a regular JSON file.");
          if (details.size > MAX_IMPORT_BYTES) throw new ProjectValidationError(`Plan must be ${MAX_IMPORT_BYTES / 1024} KB or smaller.`);
          bytes = await handle.readFile();
        } finally { await handle.close(); }
        let parsed;
        try { parsed = JSON.parse(bytes.toString("utf8")); }
        catch { throw new ProjectValidationError("Plan contains malformed JSON."); }
        const payload = validateImport(parsed);
        plans.push({ id: entry.name, valid: true, payload, fingerprint: crypto.createHash("sha256").update(bytes).digest("hex") });
      } catch (error) {
        plans.push(invalidPlan(entry.name, publicValidationMessage(error)));
      }
    }
    return plans;
  }

  #publicPlan(plan) {
    if (!plan.valid) return { id: plan.id, valid: false, error: plan.error, status: "Invalid" };
    const projects = this.projects.list();
    const currentProjects = projects.filter((project) => project.sourcePlan?.id === plan.id);
    const exact = currentProjects.find((project) => project.sourcePlan.fingerprint === plan.fingerprint);
    const appendedTargets = projects.filter((project) => (project.appendedPlans ?? []).some((entry) => entry.planId === plan.id && entry.fingerprint === plan.fingerprint))
      .map((project) => ({ id: project.id, name: project.name }));
    const prior = this.history.imports.some((entry) => entry.operation !== "append" && entry.planId === plan.id && entry.fingerprint === plan.fingerprint);
    const status = exact ? "Imported" : currentProjects.length ? "Revised version available" : appendedTargets.length ? `Appended to ${appendedTargets.length} project${appendedTargets.length === 1 ? "" : "s"}` : prior ? "Previously imported project deleted — reimport available" : "Available";
    return { id: plan.id, valid: true, name: plan.payload.name, theme: plan.payload.theme, trackCount: plan.payload.tracks.length, fingerprint: plan.fingerprint, status, canImport: !exact, appendedTargets };
  }

  async #recordImport(entry) {
    const next = { version: 1, imports: [...this.history.imports, entry] };
    const temporaryPath = path.join(this.outputDirectory, `.project-plan-imports.${this.randomUUID()}.tmp`);
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await this.fs.rename(temporaryPath, this.historyPath);
      this.history = next;
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

export function assertSafePlanId(planId) {
  if (!safePlanId(planId)) throw new ProjectValidationError("Invalid repository plan filename.");
}

function safePlanId(value) {
  return typeof value === "string" && value.length <= 180 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/i.test(value)
    && !value.includes("..") && path.basename(value) === value && !path.isAbsolute(value);
}
function invalidPlan(id, error) { return { id, valid: false, error }; }
function publicValidationMessage(error) {
  if (error instanceof ProjectValidationError) return error.message;
  return "Plan could not be read safely.";
}
function isHistoryEntry(entry) {
  return entry && typeof entry.planId === "string" && typeof entry.fingerprint === "string"
    && typeof entry.projectId === "string" && typeof entry.importedAt === "string";
}
