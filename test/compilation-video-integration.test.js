import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { CompilationVideoService, validateCompilationOutput } from "../src/compilation-video.js";
import { probeMedia, SpawnProcessRunner } from "../src/video.js";

test("real FFmpeg pipeline loops a short visual across the complete WAV and validates 1080p output", { timeout: 120_000 }, async (t) => {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg"; const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const runner = new SpawnProcessRunner();
  try { await runner.check(ffmpeg); await runner.check(ffprobe); }
  catch (error) { const reason = `Compilation video integration skipped: FFmpeg and FFprobe are required (${error.message}).`; if (process.env.REQUIRE_FFMPEG_INTEGRATION === "1") assert.fail(reason); t.skip(reason); return; }
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-compilation-real-")); t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const service = new CompilationVideoService(output, { ffmpeg, ffprobe, minimumSourceDuration: 0, toleranceSeconds: 0.5, randomUUID: () => "real" });
  await service.initialize();
  const wav = path.join(output, "mixes", "synthetic.wav"); const asset = path.join(output, "visual-assets", "loop.mp4");
  await runner.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=4", "-c:a", "pcm_s24le", "-ac", "2", wav]);
  await runner.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=0.08", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", asset]);
  const originalWav = await readFile(wav); const originalAsset = await readFile(asset);
  const source = await probeMedia(runner, ffprobe, wav); const visual = await probeMedia(runner, ffprobe, asset);
  assert.ok(source.duration / visual.duration >= 40, "The test must cross at least 40 loop boundaries to exercise cumulative timestamp behavior.");
  const plan = await service.plan({ masterFilename: "synthetic.wav", assetFilename: "loop.mp4", title: "Synthetic Compilation" });
  const exported = await service.render({ masterFilename: "synthetic.wav", assetFilename: "loop.mp4", outputFilename: plan.outputFilename, snapshot: plan.snapshot });
  const media = await probeMedia(runner, ffprobe, path.join(output, "compilation-videos", exported.filename));
  const validation = validateCompilationOutput(media, source.duration, 0.5);
  assert.equal(media.streams.find((stream) => stream.codecType === "video").pixelFormat, "yuv420p");
  assert.equal(media.streams.find((stream) => stream.codecType === "audio").sampleRate, 48000);
  assert.ok(Math.abs(validation.duration - source.duration) <= 0.5);
  assert.deepEqual(await readFile(wav), originalWav); assert.deepEqual(await readFile(asset), originalAsset);
});
