import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { ProjectNotFoundError, ProjectStore } from "../src/projects.js";
import { TrackLibrary } from "../src/library.js";
import { MixStore } from "../src/mixes.js";
import { CompilationVideoService } from "../src/compilation-video.js";
import { YouTubeUploadService, YouTubeUploadStore } from "../src/youtube-uploads.js";
import { YouTubeMetadataService, YouTubeMetadataStore } from "../src/youtube-metadata.js";

test("metadata generation integrates the real local stores and reports invalid selections", async (t) => {
  const output = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-metadata-integration-")); t.after(() => rm(output, { recursive: true, force: true }));
  const projects = new ProjectStore(output); const library = new TrackLibrary(output); const mixStore = new MixStore(output);
  await Promise.all([projects.initialize(), library.initialize(), mixStore.initialize()]);
  const project = await projects.import({ version: 1, name: "Synthetic Project", theme: "Instrumental cyberpunk industrial music.", tracks: ["Alpha", "Beta", "Gamma"].map((title) => ({ title, direction: "Industrial", prompt: `Instrumental cyberpunk industrial track for ${title}. No vocals.` })) });
  const recordings = [];
  for (const [index, planned] of project.tracks.entries()) {
    const filename = `synthetic-${index}.mp3`; await writeFile(path.join(output, filename), `audio-${index}`);
    const recording = await library.registerGenerated({ filename, title: planned.title, prompt: planned.prompt, projectId: project.id, plannedTrackId: planned.id }); await library.update(recording.id, { reviewStatus: "Keep" }); await projects.linkGenerated(project.id, planned.id, recording.id); recordings.push(recording);
  }
  const mix = await mixStore.create({ title: "Synthetic Mix", trackIds: recordings.map((item) => item.id), crossfadeSeconds: 0 });
  const timeline = recordings.map((item, index) => ({ trackId: item.id, title: item.title, startSeconds: index * 20, duration: 20 })); await mixStore.recordExport(mix.id, { filename: "synthetic.wav", snapshot: "mix-snapshot", timeline });
  const sourceDirectory = path.join(output, "compilation-videos"); await mkdir(sourceDirectory, { recursive: true }); const sourceFilename = "synthetic.mp4"; await writeFile(path.join(sourceDirectory, sourceFilename), "synthetic completed mp4");
  const uploadStore = new YouTubeUploadStore(output, "test-secret"); const uploadService = new YouTubeUploadService(output, {}, uploadStore, { probe: async () => ({ duration: 60, streams: [{ codecType: "video", duration: 60 }, { codecType: "audio", duration: 60 }] }) }); await uploadService.initialize(); const source = await uploadService.describeSource(sourceFilename);
  await writeFile(path.join(output, "compilation-video-exports.json"), JSON.stringify({ version: 1, exports: [{ filename: sourceFilename, outputFingerprint: source.fingerprint, masterFilename: "synthetic.wav", duration: 60, mixId: mix.id, mixExportSnapshot: "mix-snapshot", timeline }] }));
  const compilationVideoService = new CompilationVideoService(output, { runner: { async check() {} }, mixStore }); await compilationVideoService.initialize();
  const metadata = new YouTubeMetadataService({ store: new YouTubeMetadataStore(output), projects, library, mixStore, uploadService, compilationVideoService }); await metadata.initialize(); await metadata.saveProfile({ titleTemplate: "{project} | {duration} {genre}", compilationTitleTemplate: "{project} | {duration} Mix", introduction: "Beyond the Blackwall", tags: ["cyberpunk"], hashtags: ["#cyberpunk"] });
  const generated = await metadata.generate({ projectId: project.id, mixId: mix.id, sourceFilename }); assert.match(generated.title, /Synthetic Project/); assert.match(generated.description, /00:00 Alpha/); assert.match(generated.chapters, /00:20 Beta/); assert.equal(generated.timeline.length, 3);
  await assert.rejects(() => metadata.generate({ projectId: "missing", mixId: mix.id, sourceFilename }), (error) => error instanceof ProjectNotFoundError && error.statusCode === 404);
  await writeFile(path.join(sourceDirectory, sourceFilename), "changed source"); await assert.rejects(() => metadata.generate({ projectId: project.id, mixId: mix.id, sourceFilename }), /no longer matches its saved render provenance/);
});
