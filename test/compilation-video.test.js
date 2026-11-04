import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import {
  buildCompilationFfmpegArgs, CompilationConflictError, CompilationVideoService, validateCompilationOutput,
} from "../src/compilation-video.js";

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-compilation-video-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const runner = overrides.runner ?? { async check() {}, async run(_exe, args) { await writeFile(args.at(-1), "complete mp4"); } };
  const probe = overrides.probe ?? (async (filePath) => filePath.endsWith("master.wav")
    ? { formatName: "wav", duration: 3700.25, streams: [{ codecType: "audio", codecName: "pcm_s24le", sampleRate: 48000, channels: 2, duration: 3700.25 }] }
    : filePath.includes("visual-assets")
      ? { formatName: "mp4", duration: 12, streams: [{ codecType: "video", codecName: "h264", width: 1672, height: 942, pixelFormat: "yuv420p", duration: 12 }] }
      : { formatName: "mov,mp4", duration: 3700.3, streams: [
        { codecType: "video", codecName: "h264", width: 1920, height: 1080, pixelFormat: "yuv420p", duration: 3700.3 },
        { codecType: "audio", codecName: "aac", sampleRate: 48000, channels: 2, duration: 3700.3 },
      ] });
  const service = new CompilationVideoService(output, { runner, probe, randomUUID: () => "job", ...overrides });
  await service.initialize();
  await writeFile(path.join(output, "mixes", "master.wav"), "original wav");
  await writeFile(path.join(output, "visual-assets", "harbour.mp4"), "original visual");
  return { output, service, runner };
}

test("builds a fixed YouTube-ready loop command with complete WAV mapping", () => {
  const args = buildCompilationFfmpegArgs({ audioPath: "master.wav", assetPath: "loop.mp4", outputPath: "out.mp4", sourceDuration: 3640.15 });
  assert.deepEqual(args.slice(0, 8), ["-hide_banner", "-n", "-stream_loop", "-1", "-i", "loop.mp4", "-i", "master.wav"]);
  const filters = args[args.indexOf("-filter_complex") + 1];
  assert.match(filters, /setpts=N\/FRAME_RATE\/TB/);
  assert.match(filters, /asetpts=N\/SR\/TB/);
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
  assert.equal(args[args.indexOf("-b:a") + 1], "320k");
  assert.equal(args[args.indexOf("-ar") + 1], "48000");
  assert.equal(args[args.indexOf("-t") + 1], "3640.150000");
  assert.equal(args.includes("-shortest"), false);
});

test("lists designated inputs, plans with durations, rejects stale snapshots, and preserves sources", async (t) => {
  const values = await fixture(t);
  const sources = await values.service.listSources();
  assert.deepEqual(sources.masters.map((item) => item.filename), ["master.wav"]);
  assert.deepEqual(sources.assets.map((item) => item.filename), ["harbour.mp4"]);
  const plan = await values.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4", title: "Industrial Afterhours" });
  assert.equal(plan.expectedDuration, 3700.25);
  assert.equal(plan.outputFilename, "industrial-afterhours.mp4");
  await assert.rejects(() => values.service.render({ masterFilename: "master.wav", assetFilename: "harbour.mp4", outputFilename: plan.outputFilename, snapshot: "stale" }), CompilationConflictError);
  const rendered = await values.service.render({ masterFilename: "master.wav", assetFilename: "harbour.mp4", outputFilename: plan.outputFilename, snapshot: plan.snapshot });
  assert.equal(rendered.downloadUrl, "/compilation-videos/industrial-afterhours.mp4");
  assert.equal(await readFile(path.join(values.output, "mixes", "master.wav"), "utf8"), "original wav");
  assert.equal(await readFile(path.join(values.output, "visual-assets", "harbour.mp4"), "utf8"), "original visual");
  const next = await values.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4", title: "Industrial Afterhours" });
  assert.equal(next.outputFilename, "industrial-afterhours-2.mp4");
});

test("completed exports persist MP4-to-WAV-to-mix provenance", async (t) => {
  const timeline = [{ trackId: "a", startSeconds: 0, duration: 1900 }, { trackId: "b", startSeconds: 1892, duration: 1816 }];
  const mixStore = { list: () => [{ id: "mix-1", exports: [{ filename: "master.wav", snapshot: "mix-snapshot", timeline }] }] };
  const values = await fixture(t, { mixStore }); const plan = await values.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4", title: "Provenance" });
  await values.service.render({ masterFilename: "master.wav", assetFilename: "harbour.mp4", outputFilename: plan.outputFilename, snapshot: plan.snapshot });
  const record = values.service.getExportProvenance("provenance.mp4"); assert.equal(record.masterFilename, "master.wav"); assert.equal(record.mixId, "mix-1"); assert.equal(record.mixExportSnapshot, "mix-snapshot"); assert.deepEqual(record.timeline, timeline); assert.match(record.outputFingerprint, /^[a-f0-9]{64}$/);
  const restarted = new CompilationVideoService(values.output, { runner: values.runner, probe: async () => ({}), mixStore }); await restarted.initialize(); assert.equal(restarted.getExportProvenance("provenance.mp4").mixId, "mix-1");
});

test("diagnoses missing, duplicate and incomplete WAV provenance", async (t) => {
  const missing = await fixture(t, { mixStore: { list: () => [] } }); assert.equal((await missing.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4", title: "Missing" })).provenance.status, "missing");
  const duplicate = await fixture(t, { mixStore: { list: () => [{ id: "a", exports: [{ filename: "master.wav" }] }, { id: "b", exports: [{ filename: "master.wav" }] }] } }); assert.equal(duplicate.service.diagnoseMasterProvenance("master.wav").status, "ambiguous");
  const incomplete = await fixture(t, { mixStore: { list: () => [{ id: "a", exports: [{ filename: "master.wav", snapshot: "old" }] }] } }); assert.match(incomplete.service.diagnoseMasterProvenance("master.wav").message, /no retained timeline/i);
});

test("master recovery preview rejects cross-mix associations and verified exports", async (t) => {
  const tracks = [{ id: "a", title: "Alpha", filename: "a.mp3", duration: 1850.125 }, { id: "b", title: "Beta", filename: "b.mp3", duration: 1850.125 }];
  const mixService = { library: { get: () => ({ reviewStatus: "Keep" }) }, async preview() { return { tracks, transitions: [{ type: "concat", duration: 0 }], expectedDuration: 3700.25 }; } };
  const mixes = [{ id: "mix", trackIds: ["a", "b"], crossfadeSeconds: 0, updatedAt: "saved", exports: [{ filename: "master.wav", snapshot: "legacy" }] }, { id: "other", exports: [{ filename: "master.wav" }] }];
  const conflicting = await fixture(t, { mixService, mixStore: { list: () => structuredClone(mixes), get: () => structuredClone(mixes[0]) } });
  await assert.rejects(() => conflicting.service.planMasterRecovery({ masterFilename: "master.wav", mixId: "mix" }), /conflicting export associations/i);
  mixes.pop(); mixes[0].exports[0].timeline = [{ trackId: "a", title: "Alpha", startSeconds: 0, duration: 3700.25 }];
  const verified = await fixture(t, { mixService, mixStore: { list: () => structuredClone(mixes), get: () => structuredClone(mixes[0]) } });
  await assert.rejects(() => verified.service.planMasterRecovery({ masterFilename: "master.wav", mixId: "mix" }), /already has a verified snapshot and timeline/i);
  delete mixes[0].exports[0].timeline; mixes[0].exports[0].evidence = { mixId: "different-mix" };
  const inconsistent = await fixture(t, { mixService, mixStore: { list: () => structuredClone(mixes), get: () => structuredClone(mixes[0]) } });
  await assert.rejects(() => inconsistent.service.planMasterRecovery({ masterFilename: "master.wav", mixId: "mix" }), /evidence conflicts/i);
});

test("recovers a WAV timeline only from matching identities, order, crossfades and duration", async (t) => {
  const tracks = [{ id: "a", title: "Alpha", filename: "a.mp3", duration: 1850.125 }, { id: "b", title: "Beta", filename: "b.mp3", duration: 1850.125 }]; let recovered;
  const mix = { id: "mix", title: "Legacy", trackIds: ["a", "b"], crossfadeSeconds: 0, updatedAt: "saved", exports: [{ filename: "master.wav", snapshot: "old" }] }; const mixStore = { list: () => [mix], get: () => structuredClone(mix), async recoverExport(_id, _filename, value) { recovered = value; mix.exports[0] = value; } }; const mixService = { library: { get: () => ({ reviewStatus: "Keep" }) }, async preview() { return { tracks, transitions: [{ type: "concat", duration: 0 }], expectedDuration: 3700.25 }; } };
  const values = await fixture(t, { mixStore, mixService }); const plan = await values.service.planMasterRecovery({ masterFilename: "master.wav", mixId: "mix" }); assert.equal(plan.timeline[1].startSeconds, 1850.125); assert.match(plan.message, /Review every chapter/); await assert.rejects(() => values.service.approveMasterRecovery({ ...plan, snapshot: "stale" }), /changed/); await values.service.approveMasterRecovery(plan); assert.equal(recovered.recovered, true); assert.equal(recovered.timeline.length, 2);
});

test("recovers an existing MP4 only from retained fingerprint and verified WAV evidence", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-existing-video-recovery-")); t.after(() => rm(root, { recursive: true, force: true })); const output = path.join(root, "output"); await Promise.all([mkdir(path.join(output, "mixes"), { recursive: true }), mkdir(path.join(output, "visual-assets"), { recursive: true }), mkdir(path.join(output, "compilation-videos"), { recursive: true })]); const bytes = "existing mp4"; await writeFile(path.join(output, "compilation-videos", "legacy.mp4"), bytes); const fingerprint = crypto.createHash("sha256").update(bytes).digest("hex"); const timeline = [{ trackId: "a", title: "Alpha", startSeconds: 0, duration: 60 }]; const mixStore = { list: () => [{ id: "mix", exports: [{ filename: "master.wav", snapshot: "recovered", timeline }] }] }; await writeFile(path.join(output, "compilation-video-exports.json"), JSON.stringify({ version: 1, exports: [{ filename: "legacy.mp4", masterFilename: "master.wav", outputFingerprint: fingerprint, duration: 60 }] })); const service = new CompilationVideoService(output, { mixStore, runner: { async check() {} }, probe: async () => ({ formatName: "mp4", duration: 60, streams: [{ codecType: "video", duration: 60 }, { codecType: "audio", duration: 60 }] }) }); await service.initialize(); const plan = await service.planExistingVideoRecovery({ filename: "legacy.mp4", masterFilename: "master.wav", mixId: "mix" }); await service.approveExistingVideoRecovery(plan); assert.equal(service.getExportProvenance("legacy.mp4").mixId, "mix"); await writeFile(path.join(output, "compilation-videos", "legacy.mp4"), "changed"); await assert.rejects(() => service.planExistingVideoRecovery({ filename: "legacy.mp4", masterFilename: "master.wav", mixId: "mix" }), /fingerprint/);
});

test("changing either approved source invalidates its snapshot before FFmpeg starts", async (t) => {
  let calls = 0;
  const values = await fixture(t, { runner: { async check() {}, async run() { calls += 1; } } });
  const plan = await values.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4", title: "Snapshot" });
  await writeFile(path.join(values.output, "visual-assets", "harbour.mp4"), "changed visual content");
  await assert.rejects(() => values.service.render({ masterFilename: "master.wav", assetFilename: "harbour.mp4", outputFilename: plan.outputFilename, snapshot: plan.snapshot }), /changed/);
  assert.equal(calls, 0);
});

test("rejects traversal, missing and invalid media", async (t) => {
  const values = await fixture(t);
  await assert.rejects(() => values.service.plan({ masterFilename: "../master.wav", assetFilename: "harbour.mp4" }), /Invalid WAV/);
  await assert.rejects(() => values.service.plan({ masterFilename: "missing.wav", assetFilename: "harbour.mp4" }), /missing or invalid/);
  const invalid = await fixture(t, { probe: async () => ({ formatName: "wav", duration: 3701, streams: [] }) });
  await assert.rejects(() => invalid.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4" }), /completed WAV master/);
});

test("validates exact output streams, dimensions, pixel format, and full duration", () => {
  const valid = { formatName: "mov,mp4", duration: 3700.4, streams: [
    { codecType: "video", codecName: "h264", width: 1920, height: 1080, pixelFormat: "yuv420p", duration: 3700.4 },
    { codecType: "audio", codecName: "aac", sampleRate: 48000, channels: 2, duration: 3700.4 },
  ] };
  assert.equal(validateCompilationOutput(valid, 3700.25).duration, 3700.4);
  assert.throws(() => validateCompilationOutput({ ...valid, streams: [{ ...valid.streams[0], width: 1280 }, valid.streams[1]] }, 3700.25), /1920 × 1080/);
  assert.throws(() => validateCompilationOutput({ ...valid, streams: [valid.streams[0], { ...valid.streams[1], sampleRate: 44100 }] }, 3700.25), /48 kHz stereo/);
  assert.throws(() => validateCompilationOutput({ ...valid, duration: 3690, streams: [valid.streams[0], { ...valid.streams[1], duration: 3690 }] }, 3700.25), /complete WAV/);
});

test("duration failures report every actual timeline and signed difference", () => {
  const media = { formatName: "mov,mp4", duration: 3638.4, streams: [
    { codecType: "video", codecName: "h264", width: 1920, height: 1080, pixelFormat: "yuv420p", duration: 3638.36 },
    { codecType: "audio", codecName: "aac", sampleRate: 48000, channels: 2, duration: 3638.38 },
  ] };
  assert.throws(() => validateCompilationOutput(media, 3640.15), (error) => {
    assert.match(error.message, /Expected WAV duration: 3640\.150s/);
    assert.match(error.message, /Actual encoded audio duration: 3638\.380s \(difference -1\.770s\)/);
    assert.match(error.message, /Actual video stream duration: 3638\.360s \(difference -1\.790s\)/);
    assert.match(error.message, /Actual MP4 container duration: 3638\.400s \(difference -1\.750s\)/);
    return true;
  });
});

test("blocks overlap and cleans temporary output after FFmpeg failure", async (t) => {
  let release; const hold = new Promise((resolve) => { release = resolve; });
  const values = await fixture(t, { runner: { async check() {}, async run(_exe, args) { await writeFile(args.at(-1), "partial"); await hold; throw new Error("mock failure"); } } });
  const plan = await values.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4", title: "Failure" });
  const first = values.service.render({ masterFilename: "master.wav", assetFilename: "harbour.mp4", outputFilename: plan.outputFilename, snapshot: plan.snapshot });
  await assert.rejects(() => values.service.render({ masterFilename: "master.wav", assetFilename: "harbour.mp4", outputFilename: "other.mp4", snapshot: plan.snapshot }), /already rendering/);
  release(); await assert.rejects(() => first, /mock failure/);
  assert.deepEqual((await readdir(path.join(values.output, "compilation-videos"))).filter((name) => name.startsWith(".rendering-")), []);
});

test("failed output validation and restart cleanup remove only private incomplete files", async (t) => {
  const values = await fixture(t, { probe: async (filePath) => filePath.endsWith("master.wav")
    ? { formatName: "wav", duration: 3701, streams: [{ codecType: "audio", codecName: "pcm_s24le", sampleRate: 48000, channels: 2, duration: 3701 }] }
    : filePath.includes("visual-assets")
      ? { formatName: "mp4", duration: 12, streams: [{ codecType: "video", width: 320, height: 180, duration: 12 }] }
      : { formatName: "mp4", duration: 3701, streams: [{ codecType: "video", codecName: "h264", width: 1280, height: 720, pixelFormat: "yuv420p" }] } });
  const plan = await values.service.plan({ masterFilename: "master.wav", assetFilename: "harbour.mp4", title: "Invalid" });
  await assert.rejects(() => values.service.render({ masterFilename: "master.wav", assetFilename: "harbour.mp4", outputFilename: plan.outputFilename, snapshot: plan.snapshot }), /1920 × 1080/);
  assert.deepEqual(await readdir(path.join(values.output, "compilation-videos")), []);
  await writeFile(path.join(values.output, "compilation-videos", ".rendering-abandoned.mp4"), "partial");
  await writeFile(path.join(values.output, "compilation-videos", "completed.mp4"), "complete");
  await values.service.initialize();
  assert.deepEqual(await readdir(path.join(values.output, "compilation-videos")), ["completed.mp4"]);
  assert.equal(await readFile(path.join(values.output, "mixes", "master.wav"), "utf8"), "original wav");
  assert.equal(await readFile(path.join(values.output, "visual-assets", "harbour.mp4"), "utf8"), "original visual");
});
