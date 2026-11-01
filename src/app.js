import path from "node:path";
import express from "express";
import { validatePrompt, ValidationError } from "./prompt.js";
import { createSafeDiagnostic, generateInstrumental, toPublicError } from "./lyria.js";
import { saveMp3 } from "./output.js";
import { assertGenerationSnapshot } from "./projects.js";

export function createApp({ client, library, projects, outputDirectory, publicDirectory, logger = console, apiKey = "" }) {
  const app = express();
  let generationInProgress = false;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "160kb" }));
  app.use(express.static(publicDirectory));
  app.use("/audio", express.static(outputDirectory, {
    dotfiles: "deny",
    index: false,
    fallthrough: false,
    setHeaders(response) {
      response.setHeader("Cache-Control", "no-store");
    },
  }));

  app.post("/api/generate", async (request, response) => {
    if (generationInProgress) {
      return response.status(409).json({ error: "A generation is already in progress. Wait for it to finish." });
    }

    try {
      const prompt = validatePrompt(request.body?.prompt);
      generationInProgress = true;
      const audio = await generateInstrumental(client, prompt);
      const filename = await saveMp3(audio, outputDirectory);
      let track;
      let libraryWarning;
      try {
        track = await library.registerGenerated({ filename, prompt });
      } catch (error) {
        logger.error("MP3 saved, but track metadata could not be persisted:", { name: error?.name, message: error?.message });
        libraryWarning = "The MP3 was saved, but its metadata could not be written. Do not generate again; restart the app to import the saved MP3.";
      }
      return response.status(201).json({
        filename,
        audioUrl: `/audio/${encodeURIComponent(filename)}`,
        track,
        warning: libraryWarning,
      });
    } catch (error) {
      const publicError = reportGenerationError(error, { logger, apiKey });
      return response.status(publicError.status).json({ error: publicError.message });
    } finally {
      generationInProgress = false;
    }
  });

  app.get("/api/tracks", (_request, response) => {
    return response.json({ tracks: library.list() });
  });

  app.get("/api/projects", (_request, response) => response.json({ projects: projects.list() }));

  app.post("/api/projects", async (request, response) => {
    try {
      return response.status(201).json({ project: await projects.create(request.body ?? {}) });
    } catch (error) {
      return sendProjectError(response, error, logger);
    }
  });

  app.post("/api/projects/import", async (request, response) => {
    try {
      return response.status(201).json({ project: await projects.import(request.body) });
    } catch (error) {
      return sendProjectError(response, error, logger);
    }
  });

  app.patch("/api/projects/:projectId", async (request, response) => {
    try {
      return response.json({ project: await projects.update(request.params.projectId, request.body ?? {}) });
    } catch (error) {
      return sendProjectError(response, error, logger);
    }
  });

  app.delete("/api/projects/:projectId", async (request, response) => {
    try {
      await projects.delete(request.params.projectId);
      return response.json({ deleted: true, message: "Project deleted. Generated audio remains in the Track Library." });
    } catch (error) {
      return sendProjectError(response, error, logger);
    }
  });

  app.post("/api/projects/:projectId/tracks", async (request, response) => {
    try {
      return response.status(201).json({ track: await projects.addTrack(request.params.projectId, request.body ?? {}) });
    } catch (error) {
      return sendProjectError(response, error, logger);
    }
  });

  app.patch("/api/projects/:projectId/tracks/:trackId", async (request, response) => {
    try {
      return response.json({ track: await projects.updateTrack(request.params.projectId, request.params.trackId, request.body ?? {}) });
    } catch (error) {
      return sendProjectError(response, error, logger);
    }
  });

  app.delete("/api/projects/:projectId/tracks/:trackId", async (request, response) => {
    try {
      const track = await projects.deleteTrack(request.params.projectId, request.params.trackId);
      return response.json({ deleted: true, audioPreserved: Boolean(track.libraryTrackId) });
    } catch (error) {
      return sendProjectError(response, error, logger);
    }
  });

  app.post("/api/projects/:projectId/tracks/:trackId/generate", async (request, response) => {
    if (generationInProgress) {
      return response.status(409).json({ error: "A generation is already in progress. Wait for it to finish." });
    }
    try {
      const { project, track } = projects.getTrack(request.params.projectId, request.params.trackId);
      if (track.status === "Generated") {
        return response.status(409).json({ error: "This planned track is already generated. Play it in the Track Library." });
      }
      assertGenerationSnapshot(track, request.body?.expected);
      const generationPrompt = validatePrompt(track.prompt);
      generationInProgress = true;
      const audio = await generateInstrumental(client, generationPrompt);
      const filename = await saveMp3(audio, outputDirectory);
      let libraryTrack;
      let warning;
      try {
        libraryTrack = await library.registerGenerated({
          filename,
          title: track.title,
          prompt: generationPrompt,
          projectId: project.id,
          plannedTrackId: track.id,
        });
      } catch (error) {
        logger.error("Project MP3 saved, but library metadata could not be persisted:", { name: error?.name, message: error?.message });
        try {
          await projects.markSavedFile(project.id, track.id, filename);
          warning = "The MP3 was saved. Library registration will be repaired automatically when the app restarts; do not generate this track again.";
        } catch (projectError) {
          logger.error("Saved MP3 recovery marker could not be persisted:", { name: projectError?.name, message: projectError?.message });
          warning = "The MP3 was saved in output, but metadata could not be written. Do not generate this track again; restart the app to import it, then review the terminal diagnostic.";
        }
      }

      if (libraryTrack) {
        try {
          await projects.linkGenerated(project.id, track.id, libraryTrack.id);
        } catch (error) {
          logger.error("Generated track saved, but project link persistence failed:", { name: error?.name, message: error?.message });
          warning = "The MP3 is safely stored in the Track Library, but its project link needs recovery. Do not generate it again; restart the app to repair the link.";
        }
      }

      return response.status(201).json({
        filename,
        audioUrl: `/audio/${encodeURIComponent(filename)}`,
        track: libraryTrack,
        warning,
      });
    } catch (error) {
      if ([400, 404, 409].includes(error?.statusCode)) return sendProjectError(response, error, logger);
      const publicError = reportGenerationError(error, { logger, apiKey });
      return response.status(publicError.status).json({ error: publicError.message });
    } finally {
      generationInProgress = false;
    }
  });

  app.patch("/api/tracks/:id", async (request, response) => {
    try {
      const track = await library.update(request.params.id, request.body ?? {});
      return response.json({ track });
    } catch (error) {
      return sendLibraryError(response, error, logger);
    }
  });

  app.delete("/api/tracks/:id", async (request, response) => {
    try {
      const result = await library.delete(request.params.id);
      let referenceWarning;
      try {
        await projects.reconcileLibraryLinks(library.list());
      } catch (error) {
        logger.error("Track deleted, but project references need startup repair:", { name: error?.name, message: error?.message });
        referenceWarning = "Track deleted. Project references will be repaired when the app next starts.";
      }
      if (result.cleanupPending) {
        logger.error("Track deletion cleanup is pending until restart:", {
          trackId: request.params.id,
          message: result.cleanupError?.message,
        });
      }
      return response.json({ deleted: true, warning: result.warning || referenceWarning });
    } catch (error) {
      return sendLibraryError(response, error, logger);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error?.type === "entity.too.large") {
      return response.status(413).json({ error: "JSON request is too large. Project imports must be 128 KB or smaller." });
    }
    if (error instanceof SyntaxError && "body" in error) {
      return response.status(400).json({ error: "Request body must be valid JSON." });
    }
    return response.status(500).json({ error: "Unexpected local server error." });
  });

  return app;
}

function sendProjectError(response, error, logger) {
  if ([400, 404, 409].includes(error?.statusCode)) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  logger.error("Project operation failed:", { name: error?.name, message: error?.message });
  return response.status(500).json({ error: "Project metadata could not be updated. Check the VS Code terminal." });
}

function sendLibraryError(response, error, logger) {
  if (error?.statusCode === 400 || error?.statusCode === 404) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  logger.error("Track library operation failed:", { name: error?.name, message: error?.message });
  if (error?.name === "DeletionTransactionError") {
    return response.status(500).json({ error: error.message });
  }
  return response.status(500).json({ error: "The local track library could not be updated. Check the VS Code terminal." });
}

export function reportGenerationError(error, { logger = console, apiKey = "" } = {}) {
  if (error instanceof ValidationError) {
    return { status: error.statusCode, message: error.message };
  }

  logger.error("Lyria generation failed (no retry was attempted):", createSafeDiagnostic(error, [apiKey]));
  return toPublicError(error);
}
