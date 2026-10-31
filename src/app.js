import path from "node:path";
import express from "express";
import { validatePrompt, ValidationError } from "./prompt.js";
import { createSafeDiagnostic, generateInstrumental, toPublicError } from "./lyria.js";
import { saveMp3 } from "./output.js";

export function createApp({ client, outputDirectory, publicDirectory, logger = console, apiKey = "" }) {
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
      return response.status(201).json({
        filename,
        audioUrl: `/audio/${encodeURIComponent(filename)}`,
      });
    } catch (error) {
      const publicError = reportGenerationError(error, { logger, apiKey });
      return response.status(publicError.status).json({ error: publicError.message });
    } finally {
      generationInProgress = false;
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

export function reportGenerationError(error, { logger = console, apiKey = "" } = {}) {
  if (error instanceof ValidationError) {
    return { status: error.statusCode, message: error.message };
  }

  logger.error("Lyria generation failed (no retry was attempted):", createSafeDiagnostic(error, [apiKey]));
  return toPublicError(error);
}
