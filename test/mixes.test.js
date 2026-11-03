import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { TrackLibrary } from "../src/library.js";
import {
  buildMixFfmpegArgs, buildTransitions, calculateMixDuration, MixAssemblyService, MixConflictError,
  MixStore, MixValidationError, validateMixOutput,
} from "../src/mixes.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-mixes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const library = new TrackLibrary(output);
  await library.initialize();
  const tracks = [];
  for (let index = 1; index <= 3; index += 1) {
    await writeFile(path.join(output, `track-${index}.mp3`), `audio-${index}`);
    tracks.push(await library.registerGenerated({ filename: `track-${index}.mp3`, title: `Track ${index}`, prompt: `Instrumental ${index}` }));
  }
  const store = new MixStore(output);
  await store.initialize();
  const runner = overrides.runner ?? {
    async check() {},
    async run(_executable, args) { await writeFile(args.at(-1), "wav master"); },
  };
  const durations = new Map(tracks.map((track, index) => [track.filename, 1900 + index * 100]));
  const probe = overrides.probe ?? (async (filePath) => {
    if (filePath.endsWith(".wav")) return { formatName: "wav", duration: 5984, streams: [{ codecType: "audio", codecName: "pcm_s24le", sampleRate: 48000, channels: 2, duration: 5984 }] };
    const duration = durations.get(path.basename(filePath));
    return { formatName: "mp3", duration, streams: [{ codecType: "audio", codecName: "mp3", duration }] };
  });
  const service = new MixAssemblyService(output, library, store, { runner, probe, randomUUID: () => "mix-render", ...overrides });
  await service.initialize();
  return { root, output, library, tracks, store, service, runner };
}

test("creates, edits, orders, and persists mix drafts with future-ready transitions", async (t) => {
  const values = await fixture(t);
  const mix = await values.store.create({ title: "Night Mix", trackIds: values.tracks.map((track) => track.id), crossfadeSeconds: 8 });
  assert.deepEqual(mix.transitions.map((item) => item.duration), [8, 8]);
  const reordered = [values.tracks[2].id, values.tracks[0].id];
  await values.store.update(mix.id, { title: "Night Mix Revised", trackIds: reordered, crossfadeSeconds: 5 });
  const restarted = new MixStore(values.output);
  await restarted.initialize();
  assert.deepEqual(restarted.get(mix.id).trackIds, reordered);
  assert.deepEqual(restarted.get(mix.id).transitions, [{ fromTrackId: reordered[0], toTrackId: reordered[1], duration: 5 }]);
});

test("saved drafts preserve missing recording IDs and order while planning fails closed", async (t) => {
  const values = await fixture(t);
  const ids = [values.tracks[0].id, "missing-recording-id", values.tracks[1].id];
  const mix = await values.store.create({ title: "Missing Source", trackIds: ids, crossfadeSeconds: 8 });
  await values.store.update(mix.id, { title: "Still Missing", trackIds: ids, crossfadeSeconds: 5 });

  const restarted = new MixStore(values.output);
  await restarted.initialize();
  assert.deepEqual(restarted.get(mix.id).trackIds, ids);
  await assert.rejects(() => values.service.plan(mix.id), /Missing recordings need attention before planning: missing-recording-id/);

  values.service.validateDraftUpdate(ids, ids);
  assert.throws(() => values.service.validateDraftUpdate([...ids, "new-missing-id"], ids), /must be an existing Track Library recording/);
});

test("duration calculation subtracts every crossfade overlap", () => {
  const tracks = [{ duration: 100 }, { duration: 200 }, { duration: 300 }];
  const summary = calculateMixDuration(tracks, [{ duration: 8 }, { duration: 4 }]);
  assert.deepEqual(summary, { totalSourceDuration: 600, totalCrossfadeOverlap: 12, expectedDuration: 588 });
});

test("diagnostic preview reports actual below-minimum duration, overlap, shortfall, and exact boundary", async (t) => {
  const values = await fixture(t, { probe: async () => ({ duration: 1804, streams: [{ codecType: "audio", codecName: "mp3", duration: 1804 }] }) });
  const below = await values.service.preview({ trackIds: values.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 8 });
  assert.equal(below.totalSourceDuration, 3608);
  assert.equal(below.totalCrossfadeOverlap, 8);
  assert.equal(below.expectedDuration, 3600);
  assert.equal(below.meetsMinimum, false);
  assert.equal(below.shortfallSeconds, 0);
  const boundaryMix = await values.store.create({ title: "Boundary", trackIds: values.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 8 });
  await assert.rejects(() => values.service.plan(boundaryMix.id), /is 60:00 and must be strictly greater/);

  const one = await values.service.preview({ trackIds: [values.tracks[0].id], crossfadeSeconds: 8 });
  assert.equal(one.expectedDuration, 1804);
  assert.equal(one.shortfallSeconds, 1796);
});

test("recording duration discovery isolates missing or invalid recordings", async (t) => {
  const values = await fixture(t);
  await rm(path.join(values.output, values.tracks[1].filename));
  const recordings = await values.service.listRecordings();
  assert.equal(recordings.find((recording) => recording.id === values.tracks[0].id).duration, 1900);
  assert.match(recordings.find((recording) => recording.id === values.tracks[1].id).error, /missing or invalid/);
  await assert.rejects(() => values.service.preview({ trackIds: [values.tracks[1].id], crossfadeSeconds: 0 }), /missing or invalid/);
});

test("production planning strictly requires more than 60 minutes and validates adjacent durations", async (t) => {
  const exact = await fixture(t, { probe: async () => ({ duration: 1802, streams: [{ codecType: "audio", codecName: "mp3", duration: 1802 }] }) });
  const exactMix = await exact.store.create({ title: "Exact", trackIds: exact.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 4 });
  await assert.rejects(() => exact.service.plan(exactMix.id), /strictly greater than 60:00/);

  const fractional = await fixture(t, { probe: async () => ({ duration: 1804.25, streams: [{ codecType: "audio", codecName: "mp3", duration: 1804.25 }] }) });
  const fractionalMix = await fractional.store.create({ title: "Fractional", trackIds: fractional.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 8 });
  assert.equal((await fractional.service.plan(fractionalMix.id)).expectedDuration, 3600.5);

  const sixtyForty = await fixture(t, { probe: async () => ({ duration: 1824, streams: [{ codecType: "audio", codecName: "mp3", duration: 1824 }] }) });
  const sixtyFortyMix = await sixtyForty.store.create({ title: "Sixty Forty", trackIds: sixtyForty.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 8 });
  assert.equal((await sixtyForty.service.plan(sixtyFortyMix.id)).expectedDuration, 3640);

  const overlap = await fixture(t, { probe: async () => ({ duration: 1800.25, streams: [{ codecType: "audio", codecName: "mp3", duration: 1800.25 }] }) });
  const overlapMix = await overlap.store.create({ title: "Overlap", trackIds: overlap.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 1 });
  await assert.rejects(() => overlap.service.plan(overlapMix.id), /is 60:00 and must be strictly greater/);

  const short = await fixture(t, { probe: async () => ({ duration: 5, streams: [{ codecType: "audio", codecName: "mp3", duration: 5 }] }) });
  const shortMix = await short.store.create({ title: "Short", trackIds: short.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 8 });
  await assert.rejects(() => short.service.plan(shortMix.id), /shorter than both adjacent/);
});

test("FFmpeg filter graph uses equal-power crossfades and clean concat joins", () => {
  const tracks = [{ filePath: "one.mp3" }, { filePath: "two.mp3" }, { filePath: "three.mp3" }];
  const args = buildMixFfmpegArgs({ tracks, transitions: [{ duration: 8 }, { duration: 0 }], outputPath: "mix.wav" });
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /acrossfade=d=8:c1=qsin:c2=qsin/);
  assert.match(graph, /concat=n=2:v=0:a=1/);
  assert.equal(args[args.indexOf("-c:a") + 1], "pcm_s24le");
  assert.equal(args[args.indexOf("-ar") + 1], "48000");
  assert.equal(args[args.indexOf("-ac") + 1], "2");
  assert.equal(args.at(-1), "mix.wav");
});

test("planning uses FFprobe durations, reports summary, and rejects stale approval", async (t) => {
  const values = await fixture(t);
  const mix = await values.store.create({ title: "Long Mix", trackIds: values.tracks.map((track) => track.id), crossfadeSeconds: 8 });
  const plan = await values.service.plan(mix.id);
  assert.deepEqual(plan.tracks.map((track) => track.duration), [1900, 2000, 2100]);
  assert.equal(plan.totalSourceDuration, 6000);
  assert.equal(plan.totalCrossfadeOverlap, 16);
  assert.equal(plan.expectedDuration, 5984);
  await values.store.update(mix.id, { title: "Changed", trackIds: mix.trackIds, crossfadeSeconds: 8 });
  await assert.rejects(() => values.service.render({ mixId: mix.id, outputFilename: plan.outputFilename, snapshot: plan.snapshot }), MixConflictError);
});

test("rejects invalid selections, missing recordings, paths, and crossfade values", async (t) => {
  const values = await fixture(t);
  assert.throws(() => values.service.validateDraftTracks([values.tracks[0].id]), /at least two/);
  assert.throws(() => values.service.validateDraftTracks([values.tracks[0].id, "missing"]), /Missing recordings need attention/);
  assert.throws(() => buildTransitions(["a", "b"], 21), MixValidationError);
  const mix = await values.store.create({ title: "Missing", trackIds: values.tracks.slice(0, 2).map((track) => track.id), crossfadeSeconds: 0 });
  await rm(path.join(values.output, values.tracks[0].filename));
  await assert.rejects(() => values.service.plan(mix.id), /missing or invalid/);
  await assert.rejects(() => values.service.render({ mixId: mix.id, outputFilename: "../escape.wav", snapshot: "x" }), /Invalid WAV/);
});

test("validates WAV container, PCM format, sample rate, channels, duration, and minimum", () => {
  const valid = { formatName: "wav", duration: 4000, streams: [{ codecType: "audio", codecName: "pcm_s24le", sampleRate: 48000, channels: 2, duration: 4000 }] };
  assert.equal(validateMixOutput(valid, 4000, 3600), 4000);
  assert.throws(() => validateMixOutput({ ...valid, formatName: "mp3" }, 4000, 3600), /WAV/);
  assert.throws(() => validateMixOutput({ ...valid, streams: [{ ...valid.streams[0], codecName: "pcm_s16le" }] }, 4000, 3600), /24-bit/);
  assert.throws(() => validateMixOutput({ ...valid, streams: [{ ...valid.streams[0], sampleRate: 44100 }] }, 4000, 3600), /48,000 Hz stereo/);
  assert.throws(() => validateMixOutput({ ...valid, duration: 3000, streams: [{ ...valid.streams[0], duration: 3000 }] }, 4000, 3600), /approved plan/);

  for (const duration of [3599, 3600]) {
    const media = { ...valid, duration, streams: [{ ...valid.streams[0], duration }] };
    assert.throws(() => validateMixOutput(media, duration, 3600), /strictly longer than 60:00/);
  }
  for (const duration of [3600.5, 3640]) {
    const media = { ...valid, duration, streams: [{ ...valid.streams[0], duration }] };
    assert.equal(validateMixOutput(media, duration, 3600), duration);
  }
});

test("failed render cleans private output and preserves every source", async (t) => {
  const values = await fixture(t, { runner: { async check() {}, async run(_exe, args) { await writeFile(args.at(-1), "partial"); throw new Error("mock failure"); } } });
  const mix = await values.store.create({ title: "Failure", trackIds: values.tracks.map((track) => track.id), crossfadeSeconds: 8 });
  const plan = await values.service.plan(mix.id);
  await assert.rejects(() => values.service.render({ mixId: mix.id, outputFilename: plan.outputFilename, snapshot: plan.snapshot }), /mock failure/);
  assert.deepEqual(await readdir(path.join(values.output, "mixes")), []);
  for (let index = 0; index < 3; index += 1) assert.equal(await readFile(path.join(values.output, `track-${index + 1}.mp3`), "utf8"), `audio-${index + 1}`);
});

test("startup removes an interrupted private render without touching sources or completed masters", async (t) => {
  const values = await fixture(t);
  const mixesDirectory = path.join(values.output, "mixes");
  await writeFile(path.join(mixesDirectory, ".rendering-abandoned.wav"), "partial");
  await writeFile(path.join(mixesDirectory, "completed.wav"), "complete");
  await values.service.initialize();
  assert.deepEqual((await readdir(mixesDirectory)).sort(), ["completed.wav"]);
  for (let index = 0; index < 3; index += 1) assert.equal(await readFile(path.join(values.output, `track-${index + 1}.mp3`), "utf8"), `audio-${index + 1}`);
});

test("prevents overlapping renders and records a completed collision-safe export", async (t) => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const runner = { async check() {}, async run(_exe, args) { await hold; await writeFile(args.at(-1), "wav master"); } };
  const values = await fixture(t, { runner });
  const mix = await values.store.create({ title: "Complete Mix", trackIds: values.tracks.map((track) => track.id), crossfadeSeconds: 8 });
  const plan = await values.service.plan(mix.id);
  const first = values.service.render({ mixId: mix.id, outputFilename: plan.outputFilename, snapshot: plan.snapshot });
  await assert.rejects(() => values.service.render({ mixId: mix.id, outputFilename: "other.wav", snapshot: plan.snapshot }), /already rendering/);
  release();
  const exported = await first;
  assert.equal(exported.downloadUrl, "/mixes/complete-mix.wav");
  assert.equal(values.store.get(mix.id).exports.length, 1);
  const next = await values.service.plan(mix.id);
  assert.equal(next.outputFilename, "complete-mix-2.wav");
});
