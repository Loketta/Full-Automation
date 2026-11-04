import path from "node:path";
import express from "express";
import { validatePrompt, ValidationError } from "./prompt.js";
import { createSafeDiagnostic, generateInstrumental, toPublicError } from "./lyria.js";
import { saveMp3 } from "./output.js";
import { assertGenerationSnapshot } from "./projects.js";
import { BatchCoordinator } from "./batches.js";
import { decorateProjectsWithRecordings, regenerateRejectedRecording } from "./regeneration.js";
import { VIDEO_EXPORTS_DIRECTORY } from "./video.js";
import { MIXES_DIRECTORY } from "./mixes.js";
import { COMPILATION_VIDEOS_DIRECTORY } from "./compilation-video.js";

export function createApp({ client, library, projects, projectPlans, batches, videoService, mixStore, mixService, compilationVideoService, youtubeService, youtubeUploadService, youtubeMetadataService, outputDirectory, publicDirectory, logger = console, apiKey = "", startupGenerationBlock }) {
  const app = express();
  let generationInProgress = false;
  const batchCoordinator = batches ? new BatchCoordinator({
    store: batches,
    projects,
    logger,
    diagnoseError: (error) => createSafeDiagnostic(error, [apiKey]),
    generateTrack: (projectId, trackId) => generateProjectTrack(projectId, trackId, { strictPersistence: true }),
  }) : undefined;

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
  if (videoService) app.use("/videos", express.static(path.join(outputDirectory, VIDEO_EXPORTS_DIRECTORY), {
    dotfiles: "deny",
    index: false,
    fallthrough: false,
    setHeaders(response) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Disposition", "attachment");
    },
  }));
  if (mixService) app.use("/mixes", express.static(path.join(outputDirectory, MIXES_DIRECTORY), {
    dotfiles: "deny", index: false, fallthrough: false,
    setHeaders(response) { response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Disposition", "attachment"); },
  }));
  if (compilationVideoService) app.use("/compilation-videos", express.static(path.join(outputDirectory, COMPILATION_VIDEOS_DIRECTORY), {
    dotfiles: "deny", index: false, fallthrough: false,
    setHeaders(response) { response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Disposition", "attachment"); },
  }));

  app.post("/api/generate", async (request, response) => {
    if (generationInProgress || startupGenerationBlock || batchCoordinator?.hasActive()) {
      return response.status(409).json({ error: generationBlockedMessage(batchCoordinator, startupGenerationBlock) });
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

  if (videoService) {
    app.get("/api/video-assets", async (_request, response) => {
      try {
        return response.json({ status: videoService.status(), assets: await videoService.listAssets() });
      } catch (error) {
        return sendVideoError(response, error, logger);
      }
    });

    app.post("/api/videos/plan", async (request, response) => {
      try {
        const plan = await videoService.plan(request.body?.trackId, request.body?.assetFilename);
        return response.json({ plan: publicVideoPlan(plan), status: videoService.status() });
      } catch (error) {
        return sendVideoError(response, error, logger);
      }
    });

    app.post("/api/videos", async (request, response) => {
      try {
        const video = await videoService.render({
          trackId: request.body?.trackId,
          assetFilename: request.body?.assetFilename,
          outputFilename: request.body?.outputFilename,
        });
        return response.status(201).json({ video });
      } catch (error) {
        return sendVideoError(response, error, logger);
      }
    });
  }

  if (mixService && mixStore) {
    app.get("/api/mixes", (_request, response) => response.json({ mixes: mixStore.list(), status: mixService.status() }));
    app.get("/api/mix-recordings", async (_request, response) => {
      try { return response.json({ recordings: await mixService.listRecordings() }); }
      catch (error) { return sendMixError(response, error, logger); }
    });
    app.post("/api/mixes/preview", async (request, response) => {
      try { return response.json({ preview: await mixService.preview(request.body ?? {}) }); }
      catch (error) { return sendMixError(response, error, logger); }
    });
    app.post("/api/mixes", async (request, response) => {
      try {
        mixService.validateDraftTracks(request.body?.trackIds);
        return response.status(201).json({ mix: await mixStore.create(request.body ?? {}) });
      } catch (error) { return sendMixError(response, error, logger); }
    });
    app.patch("/api/mixes/:mixId", async (request, response) => {
      try {
        const current = mixStore.get(request.params.mixId);
        mixService.validateDraftUpdate(request.body?.trackIds, current.trackIds);
        return response.json({ mix: await mixStore.update(request.params.mixId, request.body ?? {}) });
      } catch (error) { return sendMixError(response, error, logger); }
    });
    app.post("/api/mixes/:mixId/plan", async (request, response) => {
      try { return response.json({ plan: await mixService.plan(request.params.mixId) }); }
      catch (error) { return sendMixError(response, error, logger); }
    });
    app.post("/api/mixes/:mixId/render", async (request, response) => {
      try {
        const exported = await mixService.render({ mixId: request.params.mixId, outputFilename: request.body?.outputFilename, snapshot: request.body?.snapshot });
        return response.status(201).json({ export: exported });
      } catch (error) { return sendMixError(response, error, logger); }
    });
  }

  if (compilationVideoService) {
    app.get("/api/compilation-videos/sources", async (_request, response) => {
      try { return response.json({ ...await compilationVideoService.listSources(), status: compilationVideoService.status() }); }
      catch (error) { return sendCompilationVideoError(response, error, logger); }
    });
    app.post("/api/compilation-videos/plan", async (request, response) => {
      try { return response.json({ plan: await compilationVideoService.plan(request.body ?? {}) }); }
      catch (error) { return sendCompilationVideoError(response, error, logger); }
    });
    app.post("/api/compilation-videos/render", async (request, response) => {
      try { return response.status(201).json({ video: await compilationVideoService.render(request.body ?? {}) }); }
      catch (error) { return sendCompilationVideoError(response, error, logger); }
    });
  }

  if (youtubeService) {
    app.get("/api/youtube/status", async (_request, response) => {
      try { return response.json({ connection: await youtubeService.verify() }); }
      catch (error) { return sendYouTubeError(response, error, logger); }
    });
    app.post("/api/youtube/connect", (_request, response) => {
      if (!isSameOriginRequest(_request)) return response.status(403).json({ error: "YouTube connection changes are allowed only from this local application." });
      try { return response.json({ authorizationUrl: youtubeService.beginAuthorization() }); }
      catch (error) { return sendYouTubeError(response, error, logger); }
    });
    app.get("/api/youtube/oauth/callback", async (request, response) => {
      try {
        await youtubeService.completeAuthorization(request.query ?? {});
        return response.type("html").send(oauthCallbackPage("YouTube connected", "Return to Full Automation to verify the authorized channel."));
      } catch (error) {
        logger.warn("YouTube OAuth callback failed:", { name: error?.name, message: error?.message });
        return response.status(error?.statusCode ?? 500).type("html").send(oauthCallbackPage("YouTube connection failed", error?.message ?? "Return to Full Automation and try again."));
      }
    });
    app.post("/api/youtube/disconnect", async (_request, response) => {
      if (!isSameOriginRequest(_request)) return response.status(403).json({ error: "YouTube connection changes are allowed only from this local application." });
      try { return response.json({ connection: await youtubeService.disconnect() }); }
      catch (error) { return sendYouTubeError(response, error, logger); }
    });
  }

  if (youtubeUploadService) {
    app.get("/api/youtube/uploads", async (_request, response) => {
      try { return response.json({ sources: await youtubeUploadService.listSources(), records: youtubeUploadService.list(), status: youtubeUploadService.status() }); }
      catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.post("/api/youtube/uploads/plan", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube upload actions are allowed only from this local application." });
      try { return response.json({ plan: await youtubeUploadService.plan(request.body ?? {}) }); }
      catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.post("/api/youtube/uploads", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube upload actions are allowed only from this local application." });
      try { return response.status(202).json({ upload: await youtubeUploadService.start(request.body ?? {}) }); }
      catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.post("/api/youtube/uploads/:uploadId/resume", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube upload actions are allowed only from this local application." });
      try { return response.status(202).json({ upload: await youtubeUploadService.resume(request.params.uploadId) }); }
      catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
  }

  if (youtubeMetadataService) {
    app.get("/api/youtube/metadata", (_request, response) => response.json(youtubeMetadataService.state()));
    app.post("/api/youtube/metadata/import", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube metadata actions are allowed only from this local application." });
      try { return response.json(await youtubeMetadataService.importChannel()); } catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.put("/api/youtube/metadata/profile", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube metadata actions are allowed only from this local application." });
      try { return response.json({ profile: await youtubeMetadataService.saveProfile(request.body ?? {}) }); } catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.post("/api/youtube/metadata/generate", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube metadata actions are allowed only from this local application." });
      try { return response.json({ metadata: await youtubeMetadataService.generate(request.body ?? {}) }); } catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.post("/api/youtube/metadata/approve", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube metadata actions are allowed only from this local application." });
      try { return response.json({ approval: await youtubeMetadataService.approve(request.body ?? {}) }); } catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.get("/api/youtube/metadata/analysis-export", (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube metadata actions are allowed only from this local application." });
      try { return response.json(youtubeMetadataService.exportChannelAnalysis()); } catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.post("/api/youtube/metadata/analysis-import", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube metadata actions are allowed only from this local application." });
      try { return response.json({ proposal: await youtubeMetadataService.importChannelAnalysis(request.body ?? {}) }); } catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
    app.post("/api/youtube/metadata/analysis-accept", async (request, response) => {
      if (!isSameOriginRequest(request)) return response.status(403).json({ error: "YouTube metadata actions are allowed only from this local application." });
      try { return response.json({ profile: await youtubeMetadataService.acceptChannelAnalysis(request.body?.proposalId) }); } catch (error) { return sendYouTubeUploadError(response, error, logger); }
    });
  }

  app.get("/api/projects", (_request, response) => response.json({
    projects: decorateProjectsWithRecordings(projects.list(), library.list()),
  }));

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

  if (projectPlans) {
    app.get("/api/project-plans", async (_request, response) => {
      try { return response.json({ plans: await projectPlans.list() }); }
      catch (error) { return sendProjectError(response, error, logger); }
    });
    app.post("/api/project-plans/:planId/import", async (request, response) => {
      try { return response.status(201).json({ project: await projectPlans.import(request.params.planId) }); }
      catch (error) { return sendProjectError(response, error, logger); }
    });
    app.post("/api/project-plans/:planId/append-plan", async (request, response) => {
      try { return response.json({ approval: await projectPlans.prepareAppend(request.params.planId, request.body?.targetProjectId) }); }
      catch (error) { return sendProjectError(response, error, logger); }
    });
    app.post("/api/project-plans/:planId/append", async (request, response) => {
      try { return response.status(201).json({ project: await projectPlans.append(request.params.planId, request.body) }); }
      catch (error) { return sendProjectError(response, error, logger); }
    });
  }

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
    if (generationInProgress || startupGenerationBlock || batchCoordinator?.hasActive()) {
      return response.status(409).json({ error: generationBlockedMessage(batchCoordinator, startupGenerationBlock) });
    }
    try {
      const { project, track } = projects.getTrack(request.params.projectId, request.params.trackId);
      if (track.status === "Generated") {
        return response.status(409).json({ error: "This planned track is already generated. Play it in the Track Library." });
      }
      assertGenerationSnapshot(track, request.body?.expected);
      validatePrompt(track.prompt);
      generationInProgress = true;
      const result = await generateProjectTrack(project.id, track.id);

      return response.status(201).json({
        filename: result.filename,
        audioUrl: `/audio/${encodeURIComponent(result.filename)}`,
        track: result.libraryTrack,
        warning: result.warning,
      });
    } catch (error) {
      if ([400, 404, 409].includes(error?.statusCode)) return sendProjectError(response, error, logger);
      const publicError = reportGenerationError(error, { logger, apiKey });
      return response.status(publicError.status).json({ error: publicError.message });
    } finally {
      generationInProgress = false;
    }
  });

  app.post("/api/projects/:projectId/tracks/:trackId/regenerate", async (request, response) => {
    if (generationInProgress || startupGenerationBlock || batchCoordinator?.hasActive()) {
      return response.status(409).json({ error: generationBlockedMessage(batchCoordinator, startupGenerationBlock) });
    }
    generationInProgress = true;
    try {
      const result = await regenerateRejectedRecording({
        projectId: request.params.projectId,
        plannedTrackId: request.params.trackId,
        revisedPrompt: request.body?.prompt,
        expected: request.body?.expected,
        projects,
        library,
        generateAudio: (prompt) => generateInstrumental(client, prompt),
        saveAudio: (audio) => saveMp3(audio, outputDirectory),
        logger,
      });
      return response.status(201).json({
        filename: result.replacement.filename,
        audioUrl: `/audio/${encodeURIComponent(result.replacement.filename)}`,
        track: result.replacement,
        replacedTrackId: result.replaced.id,
        warning: result.warning,
      });
    } catch (error) {
      if ([400, 404, 409].includes(error?.statusCode)) return sendProjectError(response, error, logger);
      const publicError = reportGenerationError(error, { logger, apiKey });
      return response.status(publicError.status).json({ error: publicError.message });
    } finally {
      generationInProgress = false;
    }
  });

  if (batchCoordinator) {
    app.get("/api/batches", (_request, response) => response.json({
      batches: batchCoordinator.list(),
      safety: startupGenerationBlock ?? batchCoordinator.safetyStatus(),
    }));

    app.get("/api/batches/:batchId", (request, response) => {
      try {
        return response.json({
          batch: batchCoordinator.get(request.params.batchId),
          safety: startupGenerationBlock ?? batchCoordinator.safetyStatus(),
        });
      } catch (error) {
        return sendBatchError(response, error, logger);
      }
    });

    app.post("/api/projects/:projectId/batches", async (request, response) => {
      if (generationInProgress || startupGenerationBlock) {
        return response.status(409).json({ error: generationBlockedMessage(batchCoordinator, startupGenerationBlock) });
      }
      generationInProgress = true;
      try {
        const batch = await batchCoordinator.start(request.params.projectId, request.body?.expected);
        return response.status(202).json({ batch });
      } catch (error) {
        return sendBatchError(response, error, logger);
      } finally {
        generationInProgress = false;
      }
    });

    app.post("/api/batches/:batchId/stop", async (request, response) => {
      try {
        return response.json({ batch: await batchCoordinator.stop(request.params.batchId) });
      } catch (error) {
        return sendBatchError(response, error, logger);
      }
    });
  }

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

  async function generateProjectTrack(projectId, trackId, { strictPersistence = false } = {}) {
    const { project, track } = projects.getTrack(projectId, trackId);
    if (track.status === "Generated") throw Object.assign(new Error("This planned track is already generated."), { statusCode: 409 });
    const generationPrompt = validatePrompt(track.prompt);
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
      if (strictPersistence) throw new Error(`Audio was saved as ${filename}, but metadata persistence failed. ${warning}`, { cause: error });
    }

    if (libraryTrack) {
      try {
        await projects.linkGenerated(project.id, track.id, libraryTrack.id);
      } catch (error) {
        logger.error("Generated track saved, but project link persistence failed:", { name: error?.name, message: error?.message });
        warning = "The MP3 is safely stored in the Track Library, but its project link needs recovery. Do not generate it again; restart the app to repair the link.";
        if (strictPersistence) throw new Error(`Audio and library metadata were saved as ${filename}, but project persistence failed.`, { cause: error });
      }
    }
    return { filename, libraryTrack, libraryTrackId: libraryTrack?.id, warning };
  }
}

function sendBatchError(response, error, logger) {
  if ([400, 404, 409].includes(error?.statusCode)) return response.status(error.statusCode).json({ error: error.message });
  logger.error("Batch operation failed:", { name: error?.name, message: error?.message });
  return response.status(500).json({ error: "Batch state could not be safely updated. No further request was started. Check the VS Code terminal." });
}

function sendVideoError(response, error, logger) {
  if ([400, 404, 409, 503].includes(error?.statusCode)) return response.status(error.statusCode).json({ error: error.message });
  logger.error("Local video export failed:", { name: error?.name, message: error?.message, code: error?.code });
  return response.status(500).json({ error: error?.message || "Video rendering failed. No completed export was published. Check the terminal." });
}

function sendMixError(response, error, logger) {
  if ([400, 404, 409, 503].includes(error?.statusCode)) return response.status(error.statusCode).json({ error: error.message });
  logger.error("Local audio mix operation failed:", { name: error?.name, message: error?.message, code: error?.code });
  return response.status(500).json({ error: error?.message || "Audio mix rendering failed. No completed master was published." });
}

function sendCompilationVideoError(response, error, logger) {
  if ([400, 404, 409, 503].includes(error?.statusCode)) return response.status(error.statusCode).json({ error: error.message });
  logger.error("Compilation video operation failed:", { name: error?.name, message: error?.message, code: error?.code });
  return response.status(500).json({ error: error?.message || "Compilation video rendering failed. No completed export was published." });
}

function sendYouTubeError(response, error, logger) {
  if ([400, 409, 503].includes(error?.statusCode)) return response.status(error.statusCode).json({ error: error.message });
  logger.error("YouTube connection operation failed:", { name: error?.name, message: error?.message, code: error?.code });
  return response.status(500).json({ error: "The local YouTube connection could not be updated. No upload was attempted. Check the terminal." });
}

function sendYouTubeUploadError(response, error, logger) {
  if ([400, 404, 409, 502, 503].includes(error?.statusCode)) return response.status(error.statusCode).json({ error: error.message });
  logger.error("YouTube upload operation failed:", { name: error?.name, message: error?.message, code: error?.code });
  return response.status(500).json({ error: "YouTube upload state could not be safely updated. No replacement upload was started. Check the terminal." });
}

function oauthCallbackPage(title, message) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head><body><h1>${escape(title)}</h1><p>${escape(message)}</p><p>You can close this window.</p><script>window.opener?.postMessage({type:"youtube-oauth-complete"}, window.location.origin);</script></body></html>`;
}

function isSameOriginRequest(request) {
  const origin = request.get("origin");
  return !origin || origin === `${request.protocol}://${request.get("host")}`;
}

function publicVideoPlan(plan) {
  return { track: plan.track, asset: plan.asset, outputFilename: plan.outputFilename };
}

function generationBlockedMessage(batchCoordinator, startupGenerationBlock) {
  return startupGenerationBlock?.message
    ?? batchCoordinator?.safetyStatus()?.message
    ?? "A generation is already in progress. Wait for it to finish.";
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
