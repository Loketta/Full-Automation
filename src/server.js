import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createLyriaClient } from "./lyria.js";
import { TrackLibrary } from "./library.js";
import { ProjectStore } from "./projects.js";
import { BatchStore } from "./batches.js";
import { recoverReplacementTransactions } from "./regeneration.js";
import { VideoAssemblyService } from "./video.js";
import { MixAssemblyService, MixStore } from "./mixes.js";
import { ProjectPlanService } from "./project-plans.js";
import { CompilationVideoService } from "./compilation-video.js";
import { YouTubeConnectionService } from "./youtube.js";
import { YouTubeUploadService, YouTubeUploadStore } from "./youtube-uploads.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

try {
  const client = createLyriaClient(process.env.GEMINI_API_KEY);
  const outputDirectory = path.join(projectRoot, "output");
  const library = new TrackLibrary(outputDirectory);
  await library.initialize();
  const projects = new ProjectStore(outputDirectory);
  await projects.initialize();
  const projectPlans = new ProjectPlanService(path.join(projectRoot, "project-plans"), outputDirectory, projects);
  await projectPlans.initialize();
  const replacementRecovery = await recoverReplacementTransactions(projects, library);
  await projects.reconcileLibraryLinks(library.list());
  const batches = new BatchStore(outputDirectory);
  await batches.initialize();
  const videoService = new VideoAssemblyService(outputDirectory, library, {
    executable: process.env.FFMPEG_PATH || "ffmpeg",
    probeExecutable: process.env.FFPROBE_PATH || "ffprobe",
  });
  const videoStatus = await videoService.initialize();
  if (!videoStatus.available) console.warn(videoStatus.error);
  const mixStore = new MixStore(outputDirectory);
  await mixStore.initialize();
  const mixService = new MixAssemblyService(outputDirectory, library, mixStore, {
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  });
  const mixStatus = await mixService.initialize();
  if (!mixStatus.available) console.warn(mixStatus.error);
  const compilationVideoService = new CompilationVideoService(outputDirectory, {
    ffmpeg: process.env.FFMPEG_PATH || "ffmpeg",
    ffprobe: process.env.FFPROBE_PATH || "ffprobe",
  });
  const compilationVideoStatus = await compilationVideoService.initialize();
  if (!compilationVideoStatus.available) console.warn(compilationVideoStatus.error);
  const youtubeService = new YouTubeConnectionService({
    outputDirectory,
    clientId: process.env.YOUTUBE_OAUTH_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.YOUTUBE_OAUTH_REDIRECT_URI || `http://127.0.0.1:${port}/api/youtube/oauth/callback`,
  });
  await youtubeService.initialize();
  const youtubeUploadStore = new YouTubeUploadStore(outputDirectory, process.env.YOUTUBE_OAUTH_CLIENT_SECRET);
  const youtubeUploadService = new YouTubeUploadService(outputDirectory, youtubeService, youtubeUploadStore, { ffprobe: process.env.FFPROBE_PATH || "ffprobe" });
  await youtubeUploadService.initialize();
  const app = createApp({
    client,
    library,
    projects,
    projectPlans,
    batches,
    videoService,
    mixStore,
    mixService,
    compilationVideoService,
    youtubeService,
    youtubeUploadService,
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
