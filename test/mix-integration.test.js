import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { TrackLibrary } from "../src/library.js";
import { MixAssemblyService, MixStore, validateMixOutput } from "../src/mixes.js";
import { probeMedia, SpawnProcessRunner } from "../src/video.js";

test("real FFmpeg pipeline creates and verifies a crossfaded 24-bit WAV master", { timeout: 60_000 }, async (t) => {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const runner = new SpawnProcessRunner();
  try { await runner.check(ffmpeg); await runner.check(ffprobe); }
  catch (error) {
    const reason = `Audio mix integration skipped: FFmpeg and FFprobe are required (${error.message}).`;
    if (process.env.REQUIRE_FFMPEG_INTEGRATION === "1") assert.fail(reason);
    t.skip(reason); return;
  }
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-mix-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  await library.initialize();
  const sources = [];
  for (const [index, duration] of [1.4, 1.2].entries()) {
    const filename = `source-${index + 1}.mp3`;
    const filePath = path.join(output, filename);
    await runner.run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i", `sine=frequency=${440 + index * 220}:sample_rate=44100:duration=${duration}`, "-c:a", "libmp3lame", "-b:a", "128k", filePath]);
    const bytes = await readFile(filePath);
    const track = await library.registerGenerated({ filename, title: `Source ${index + 1}`, prompt: "Synthetic offline mix source" });
    sources.push({ track, filePath, bytes });
  }
  const store = new MixStore(output);
  await store.initialize();
  const service = new MixAssemblyService(output, library, store, {
    ffmpeg, ffprobe, runner,
    minimumDurationSeconds: 1,
    toleranceSeconds: 0.35,
    randomUUID: () => "real-mix-render",
  });
  await service.initialize();
  const mix = await store.create({ title: "Synthetic Crossfade", trackIds: sources.map((source) => source.track.id), crossfadeSeconds: 0.25 });
  const plan = await service.plan(mix.id);
  const exported = await service.render({ mixId: mix.id, outputFilename: plan.outputFilename, snapshot: plan.snapshot });
  const media = await probeMedia(runner, ffprobe, path.join(output, "mixes", exported.filename));
  const actual = validateMixOutput(media, plan.expectedDuration, 1, 0.35);
  const audio = media.streams.find((stream) => stream.codecType === "audio");
  assert.equal(media.formatName, "wav");
  assert.equal(audio.codecName, "pcm_s24le");
  assert.equal(audio.sampleRate, 48000);
  assert.equal(audio.channels, 2);
  assert.ok(Math.abs(actual - plan.expectedDuration) <= 0.35);
  for (const source of sources) assert.deepEqual(await readFile(source.filePath), source.bytes);
});
