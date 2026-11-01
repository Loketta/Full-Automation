import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createLyriaClient } from "./lyria.js";
import { TrackLibrary } from "./library.js";
import { ProjectStore } from "./projects.js";
import { BatchStore } from "./batches.js";
import { recoverReplacementTransactions } from "./regeneration.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

try {
  const client = createLyriaClient(process.env.GEMINI_API_KEY);
  const outputDirectory = path.join(projectRoot, "output");
  const library = new TrackLibrary(outputDirectory);
  await library.initialize();
  const projects = new ProjectStore(outputDirectory);
  await projects.initialize();
  const replacementRecovery = await recoverReplacementTransactions(projects, library);
  await projects.reconcileLibraryLinks(library.list());
  const batches = new BatchStore(outputDirectory);
  await batches.initialize();
  const app = createApp({
    client,
    library,
    projects,
    batches,
    startupGenerationBlock: replacementRecovery.pending ? {
      blocked: true,
      outcomeUncertain: true,
      message: replacementRecovery.message,
    } : undefined,
    apiKey: process.env.GEMINI_API_KEY,
    outputDirectory,
    publicDirectory: path.join(projectRoot, "public"),
  });

  app.listen(port, "127.0.0.1", () => {
    console.log(`Lyria Local Studio is ready at http://127.0.0.1:${port}`);
    console.log("No paid request is made until you click Generate and confirm.");
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
