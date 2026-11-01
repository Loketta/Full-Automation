import path from "node:path";
import express from "express";
import { validatePrompt, ValidationError } from "./prompt.js";
import { createSafeDiagnostic, generateInstrumental, toPublicError } from "./lyria.js";
import { saveMp3 } from "./output.js";

export function createApp({ client, library, outputDirectory, publicDirectory, logger = console, apiKey = "" }) {
  const app = express();
  let generationInProgress = false;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
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
      if (result.cleanupPending) {
        logger.error("Track deletion cleanup is pending until restart:", {
          trackId: request.params.id,
          message: result.cleanupError?.message,
        });
      }
      return response.json({ deleted: true, warning: result.warning });
    } catch (error) {
      return sendLibraryError(response, error, logger);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && "body" in error) {
      return response.status(400).json({ error: "Request body must be valid JSON." });
    }
    return response.status(500).json({ error: "Unexpected local server error." });
  });

  return app;
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
