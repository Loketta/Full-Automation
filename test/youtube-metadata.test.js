import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { analyseChannelStyle, BEYOND_BLACKWALL_CHANNEL_ID, buildChapterTimeline, formatChapters, validateCompletedTimeline, YouTubeMetadataService, YouTubeMetadataStore } from "../src/youtube-metadata.js";
import { buildMixTimeline } from "../src/mixes.js";
import { buildChannelAnalysisExport } from "../src/youtube-style-profile.js";

function video(id, title, description = "Recurring intro\n\nBody\n\nRecurring footer", tags = ["dark ambient", "cyberpunk"]) { return { id, snippet: { title, description, tags, publishedAt: "2026-01-01T00:00:00Z", thumbnails: { high: { url: `https://thumb.test/${id}.jpg` } } }, contentDetails: { duration: "PT1H2M3S" } }; }

test("imports the exact authorized channel through paginated uploads and extracts recurring style", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-metadata-")); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; const youtube = {
    channels: { async list(args) { calls.push(["channels", args]); return { data: { items: [{ id: BEYOND_BLACKWALL_CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: "UU-style" } } }] } }; } },
    playlistItems: { async list(args) { calls.push(["playlist", args]); return args.pageToken ? { data: { items: [{ contentDetails: { videoId: "v3" } }] } } : { data: { items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }], nextPageToken: "next" } }; } },
    videos: { async list(args) { calls.push(["videos", args]); return { data: { items: args.id.map((id) => video(id, `${id} | 1 Hour Cyberpunk Mix`)) } }; } },
  };
  const store = new YouTubeMetadataStore(root); const service = new YouTubeMetadataService({ connection: { async getVerifiedReadContext() { return { channel: { id: BEYOND_BLACKWALL_CHANNEL_ID }, youtube }; } }, store, now: () => new Date("2026-11-04T00:00:00Z") }); await service.initialize();
  const state = await service.importChannel(); assert.equal(state.importedVideos.length, 3); assert.equal(calls.filter(([name]) => name === "playlist").length, 2); assert.equal(calls.filter(([name]) => name === "videos").length, 1);
  assert.match(state.profile.titleTemplate, /1 Hour Cyberpunk Mix/); assert.equal(state.profile.introduction, "Recurring intro"); assert.deepEqual(state.profile.tags, ["dark ambient", "cyberpunk"]); assert.equal(state.profile.informedByVideoIds.length, 3);
  assert.doesNotMatch(await readFile(path.join(root, "youtube-channel-style.json"), "utf8"), /access_token|refresh_token/i);
});

test("rejects a different authorized channel before any channel API request", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-wrong-channel-")); t.after(() => rm(root, { recursive: true, force: true })); let apiCalls = 0;
  const store = new YouTubeMetadataStore(root); const service = new YouTubeMetadataService({ connection: { async getVerifiedReadContext() { return { channel: { id: "UC-wrong" }, youtube: { channels: { async list() { apiCalls += 1; } } } }; } }, store }); await service.initialize();
  await assert.rejects(() => service.importChannel(), /Beyond the Blackwall/); assert.equal(apiCalls, 0);
});

test("quota or incomplete import leaves the existing edited profile intact", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-import-failure-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new YouTubeMetadataStore(root); const youtube = { channels: { async list() { return { data: { items: [{ id: BEYOND_BLACKWALL_CHANNEL_ID, contentDetails: { relatedPlaylists: { uploads: "UU" } } }] } }; } }, playlistItems: { async list() { const error = new Error("quotaExceeded"); error.code = 403; throw error; } } };
  const service = new YouTubeMetadataService({ connection: { async getVerifiedReadContext() { return { channel: { id: BEYOND_BLACKWALL_CHANNEL_ID }, youtube }; } }, store }); await service.initialize(); await service.saveProfile({ titleTemplate: "My saved {project}" });
  await assert.rejects(() => service.importChannel(), /quota/); assert.equal(service.state().profile.titleTemplate, "My saved {project}");
});

test("insufficient history reports uncertainty instead of inventing recurring findings", () => {
  const profile = analyseChannelStyle([{ id: "one", title: "One-off title", description: "Unique copy", tags: ["unique"], thumbnailUrl: "https://one.test/a.jpg" }]);
  assert.equal(profile.introduction, ""); assert.deepEqual(profile.tags, []); assert.match(profile.findings[0], /Insufficient/);
});

test("chapter timeline subtracts crossfades and enforces YouTube chapter rules", () => {
  const tracks = [
    { id: "a", title: "A", duration: 100, projectTrack: { title: "Alpha" } },
    { id: "b", title: "B", duration: 80, projectTrack: { title: "Beta" } },
    { id: "c", title: "C", duration: 70, projectTrack: { title: "Gamma" } },
  ];
  const timeline = buildChapterTimeline(tracks, [{ duration: 8 }, { duration: 5 }]); assert.deepEqual(timeline.map((item) => item.startSeconds), [0, 92, 167]); assert.equal(formatChapters(timeline), "00:00 Alpha\n01:32 Beta\n02:47 Gamma");
  assert.throws(() => buildChapterTimeline(tracks.slice(0, 2), [{ duration: 0 }]), /at least three/);
  assert.throws(() => buildChapterTimeline([{ ...tracks[0], duration: 10 }, tracks[1], tracks[2]], [{ duration: 1 }, { duration: 0 }]), /at least 10 seconds/);
  assert.deepEqual(buildMixTimeline(tracks, [{ duration: 8 }, { duration: 5 }]).map((item) => item.startSeconds), [0, 92, 167]);
});

test("profile edits persist and generated approval invalidates on source or project changes", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-generate-")); t.after(() => rm(root, { recursive: true, force: true }));
  let projectName = "Industrial Afterhours"; let fingerprint = "a".repeat(64); let uploadCalls = 0;
  const project = () => ({ id: "project", name: projectName, theme: "Instrumental cyberpunk industrial music.", tracks: ["a", "b", "c"].map((id) => ({ id: `p-${id}`, title: `Track ${id.toUpperCase()}`, libraryTrackId: id })) });
  const timeline = [0, 1292, 2584].map((startSeconds, index) => ({ trackId: ["a", "b", "c"][index], title: ["a", "b", "c"][index], startSeconds, duration: 1300 }));
  const mix = () => ({ id: "mix", title: "Mix", trackIds: ["a", "b", "c"], crossfadeSeconds: 8, updatedAt: "now", exports: [{ filename: "master.wav", snapshot: "mix-snapshot", timeline }] });
  const store = new YouTubeMetadataStore(root); const service = new YouTubeMetadataService({ store, projects: { get: () => project() }, library: { get: (id) => ({ id, reviewStatus: "Keep" }) }, mixStore: { get: () => mix() }, uploadService: { async describeSource(filename) { uploadCalls += 1; return { filename, fingerprint, size: 123, duration: 3884 }; } }, compilationVideoService: { getExportProvenance: () => ({ filename: "mix.mp4", outputFingerprint: fingerprint, masterFilename: "master.wav", duration: 3884, mixId: "mix", mixExportSnapshot: "mix-snapshot", timeline }) }, now: () => new Date("2026-11-04T00:00:00Z") });
  await service.initialize(); await service.saveProfile({ titleTemplate: "{project} | {duration} {genre}", introduction: "Enter the Blackwall.", reusableText: "Reusable", footer: "Footer", links: "https://example.test", genreVocabulary: "cyberpunk, industrial", tags: "music", hashtags: "#BeyondTheBlackwall" });
  const restarted = new YouTubeMetadataStore(root); await restarted.initialize(); assert.equal(restarted.get().profile.introduction, "Enter the Blackwall.");
  const generated = await service.generate({ projectId: "project", mixId: "mix", sourceFilename: "mix.mp4" }); assert.ok(generated.title.length <= 100); assert.match(generated.description, /00:00 Track A/); assert.match(generated.description, /#BeyondTheBlackwall/); assert.equal(uploadCalls, 1);
  const approval = await service.approve({ projectId: "project", mixId: "mix", sourceFilename: "mix.mp4", inputSnapshot: generated.inputSnapshot, title: `${generated.title} Edited`, description: generated.description, tags: generated.tags }); assert.match(approval.title, /Edited/); assert.equal(service.state().approvals.length, 1);
  projectName = "Changed"; await assert.rejects(() => service.approve({ projectId: "project", mixId: "mix", sourceFilename: "mix.mp4", inputSnapshot: generated.inputSnapshot, title: generated.title, description: generated.description, tags: generated.tags }), /changed/);
  fingerprint = "b".repeat(64); const changed = await service.generate({ projectId: "project", mixId: "mix", sourceFilename: "mix.mp4" }); assert.notEqual(changed.inputSnapshot, generated.inputSnapshot);
});

test("rejects conflicting provenance but generates legacy metadata without guessed chapters", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-provenance-")); t.after(() => rm(root, { recursive: true, force: true })); const fingerprint = "c".repeat(64);
  const timeline = [0, 20, 40].map((startSeconds, index) => ({ trackId: `t${index}`, title: `T${index}`, startSeconds, duration: index === 2 ? 20 : 30 }));
  let provenance;
  const service = new YouTubeMetadataService({ store: new YouTubeMetadataStore(root), projects: { get: () => ({ id: "p", name: "P", theme: "Dark industrial music.", tracks: timeline.map((item) => ({ title: item.title, libraryTrackId: item.trackId })) }) }, library: { get: () => ({ reviewStatus: "Keep" }) }, mixStore: { get: () => ({ id: "selected", exports: [{ filename: "master.wav", snapshot: "snap", timeline }] }) }, uploadService: { async describeSource(filename) { return { filename, fingerprint, duration: 60 }; } }, compilationVideoService: { getExportProvenance() { return provenance; } } });
  await service.initialize(); await service.saveProfile({ titleTemplate: "{project}" });
  provenance = { outputFingerprint: fingerprint, masterFilename: "master.wav", duration: 60, mixId: "other", mixExportSnapshot: "snap", timeline };
  await assert.rejects(() => service.generate({ projectId: "p", mixId: "selected", sourceFilename: "video.mp4" }), /different audio mix/);
  provenance = { outputFingerprint: "d".repeat(64) }; await assert.rejects(() => service.generate({ projectId: "p", mixId: "selected", sourceFilename: "changed.mp4" }), /fingerprint conflicts/);
  provenance = undefined; const fallback = await service.generate({ projectId: "p", mixId: "selected", sourceFilename: "legacy.mp4" }); assert.equal(fallback.chapters, ""); assert.equal(fallback.timeline.length, 0); assert.match(fallback.warnings.join(" "), /No saved MP4 provenance.*no timestamps were guessed/i); assert.doesNotMatch(fallback.description, /00:00/);
  provenance = { outputFingerprint: fingerprint, masterFilename: "master.wav", duration: 60, mixId: "selected", mixExportSnapshot: "snap", timeline }; await assert.rejects(() => service.approve({ projectId: "p", mixId: "selected", sourceFilename: "legacy.mp4", inputSnapshot: fallback.inputSnapshot, title: fallback.title, description: fallback.description, tags: fallback.tags }), /changed/);
});

test("completed timeline validates the final chapter and exact video-duration boundary", () => {
  const valid = [{ trackId: "a", startSeconds: 0, duration: 20 }, { trackId: "b", startSeconds: 20, duration: 20 }, { trackId: "c", startSeconds: 40, duration: 20 }];
  assert.equal(validateCompletedTimeline(valid, 60, 60).length, 3);
  assert.throws(() => validateCompletedTimeline([{ ...valid[0] }, { ...valid[1] }, { ...valid[2], startSeconds: 51, duration: 9 }], 60, 60), /final chapter.*10 seconds/i);
  assert.throws(() => validateCompletedTimeline(valid, 65, 60), /duration does not match/i);
  assert.throws(() => validateCompletedTimeline([{ ...valid[0] }, { ...valid[1] }, { ...valid[2], duration: 15 }], 60, 60), /does not end/i);
});

test("individual-track metadata uses its own template, grounded genre profile and approval snapshot", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-track-metadata-")); t.after(() => rm(root, { recursive: true, force: true })); let direction = "Industrial combat music for tabletop gaming";
  const project = { id: "p", name: "Night Run", theme: "Cyberpunk industrial soundtrack for tabletop sessions.", tracks: [] }; const track = { id: "pt", title: "Steel Horizon", direction, prompt: "Instrumental industrial combat music. No vocals.", status: "Generated", libraryTrackId: "recording" }; project.tracks = [track];
  const service = new YouTubeMetadataService({ store: new YouTubeMetadataStore(root), projects: { getTrack() { return { project: structuredClone(project), track: { ...track, direction } }; } }, library: { get() { return { id: "recording", filename: "steel.mp3", title: "Steel Horizon", createdAt: "2026-01-01", reviewStatus: "Keep" }; } } }); await service.initialize();
  await assert.rejects(() => service.saveProfile({ individualTrackTitleTemplate: "{track} {unsupported}" }), /unsupported.*\{unsupported\}/i);
  await service.saveProfile({ individualTrackTitleTemplate: "{track} // {genre}", introduction: "Music for {mood_or_scene}.", hashtags: ["#cyberpunk"], genreProfiles: [{ genre: "industrial", keywords: ["industrial", "combat"], tags: ["industrial music"], hashtags: ["#industrial"], sourceVideoIds: ["v"] }] });
  const generated = await service.generateIndividual({ projectId: "p", trackId: "pt" }); assert.equal(generated.title, "Steel Horizon // industrial"); assert.match(generated.description, /Music for tabletop gaming\./); assert.deepEqual(generated.selectedGenreProfiles, ["industrial"]); assert.equal(generated.chapters, "");
  const approval = await service.approve({ kind: "individual", projectId: "p", trackId: "pt", inputSnapshot: generated.inputSnapshot, title: generated.title, description: generated.description, tags: generated.tags }); assert.equal(approval.kind, "individual"); direction = "Changed direction"; await assert.rejects(() => service.approve({ kind: "individual", projectId: "p", trackId: "pt", inputSnapshot: generated.inputSnapshot, title: generated.title, description: generated.description, tags: generated.tags }), /changed/);
  await service.store.update((data) => { data.profile.individualTrackTitleTemplate = "{track} {legacy_unknown}"; }); await assert.rejects(() => service.generateIndividual({ projectId: "p", trackId: "pt" }), /unsupported.*\{legacy_unknown\}/i); assert.equal(service.state().profile.individualTrackTitleTemplate, "{track} {legacy_unknown}");
});

test("reviewed proposal remains separate until explicit acceptance and preserves unrelated manual fields", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-analysis-proposal-")); t.after(() => rm(root, { recursive: true, force: true })); const store = new YouTubeMetadataStore(root); await store.initialize();
  const imports = [{ id: "v1", title: "Mix", description: "Description", tags: ["music"], duration: 3600, publishedAt: "2026-01-01T00:00:00Z" }, { id: "v2", title: "Track", description: "Description", tags: ["music"], duration: 240, publishedAt: "2026-01-02T00:00:00Z" }];
  await store.update((data) => { data.imports = imports; data.profile = { titleTemplate: "Manual", thumbnailBranding: "Keep this manual reference", userEdited: true }; }); const service = new YouTubeMetadataService({ store, now: () => new Date("2026-11-04T00:00:00Z"), randomUUID: () => "proposal-1" });
  const exported = service.exportChannelAnalysis(); const input = { version: 1, channelId: BEYOND_BLACKWALL_CHANNEL_ID, datasetFingerprint: exported.datasetFingerprint, report: { summary: "Two formats", observedConventions: [{ category: "title", pattern: "Two formats", sourceVideoIds: ["v1", "v2"], examples: ["Mix"] }], inconsistencies: [], recommendations: [] }, proposedProfile: { compilationTitleTemplate: "{project} | Mix", individualTrackTitleTemplate: "{track} | Track", universalBranding: { introduction: "Intro", footer: "Footer", callsToAction: ["Subscribe"], recurringLinks: ["https://example.test"] }, universalTags: ["music"], universalHashtags: ["#Blackwall"], genreProfiles: [{ genre: "industrial", keywords: ["dark"], tags: ["industrial"], hashtags: ["#Industrial"], sourceVideoIds: ["v1"] }] } };
  await service.importChannelAnalysis(input); assert.equal(service.state().profile.titleTemplate, "Manual"); await assert.rejects(() => service.acceptChannelAnalysis("wrong"), /missing or changed/);
  const accepted = await service.acceptChannelAnalysis("proposal-1"); assert.equal(accepted.compilationTitleTemplate, "{project} | Mix"); assert.equal(accepted.individualTrackTitleTemplate, "{track} | Track"); assert.equal(accepted.thumbnailBranding, "Keep this manual reference"); assert.equal(service.state().analysisProposal, undefined);
});

test("matching bundled analysis is staged once, requires approval, and remembers that approval", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-bundled-analysis-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new YouTubeMetadataStore(root); await store.initialize(); const imports = [{ id: "v1", title: "Mix", description: "Description", tags: [], duration: 3600, publishedAt: "2026-01-01T00:00:00Z" }, { id: "v2", title: "Track", description: "Description", tags: [], duration: 240, publishedAt: "2026-01-02T00:00:00Z" }];
  await store.update((data) => { data.imports = imports; data.profile = { titleTemplate: "Manual", thumbnailBranding: "Preserve me", userEdited: true }; }); const exported = buildChannelAnalysisExport({ channelId: BEYOND_BLACKWALL_CHANNEL_ID, imports });
  const bundled = { version: 1, channelId: BEYOND_BLACKWALL_CHANNEL_ID, datasetFingerprint: exported.datasetFingerprint, report: { summary: "Reviewed", observedConventions: [{ category: "titles", pattern: "Two formats", sourceVideoIds: ["v1", "v2"], examples: ["Mix"] }], inconsistencies: [], recommendations: [] }, proposedProfile: { compilationTitleTemplate: "{project} | Mix", individualTrackTitleTemplate: "{track} | Track", universalBranding: { introduction: "Intro", footer: "Footer", callsToAction: [], recurringLinks: [] }, universalTags: [], universalHashtags: [], genreProfiles: [] } }; const bundledPath = path.join(root, "bundled.json"); await writeFile(bundledPath, JSON.stringify(bundled));
  const service = new YouTubeMetadataService({ store, bundledAnalysisPath: bundledPath, now: () => new Date("2026-11-04T00:00:00Z") }); await service.initialize();
  assert.equal(service.state().bundledAnalysis.compatible, true); assert.equal(service.state().bundledAnalysis.applied, false); assert.equal(service.state().analysisProposal.origin, "bundled"); assert.equal(service.state().profile.titleTemplate, "Manual");
  await service.acceptChannelAnalysis(`bundled:${exported.datasetFingerprint}`); assert.equal(service.state().profile.thumbnailBranding, "Preserve me"); assert.equal(service.state().profile.compilationTitleTemplate, "{project} | Mix");
  const restarted = new YouTubeMetadataService({ store: new YouTubeMetadataStore(root), bundledAnalysisPath: bundledPath }); await restarted.initialize(); assert.equal(restarted.state().bundledAnalysis.applied, true); assert.equal(restarted.state().analysisProposal, undefined);
});

test("mismatched bundled analysis is visible but never staged or applied", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-stale-bundled-analysis-")); t.after(() => rm(root, { recursive: true, force: true })); const store = new YouTubeMetadataStore(root); await store.initialize(); await store.update((data) => { data.imports = [{ id: "different", title: "Different", description: "", tags: [], duration: 1, publishedAt: "2026-01-01T00:00:00Z" }]; data.profile = { titleTemplate: "Keep me", userEdited: true }; });
  const source = JSON.parse(await readFile("channel-analysis/beyond-the-blackwall-analysis.json", "utf8")); const bundledPath = path.join(root, "bundled.json"); await writeFile(bundledPath, JSON.stringify(source)); const service = new YouTubeMetadataService({ store, bundledAnalysisPath: bundledPath }); await service.initialize();
  assert.equal(service.state().bundledAnalysis.available, true); assert.equal(service.state().bundledAnalysis.compatible, false); assert.equal(service.state().analysisProposal, undefined); assert.equal(service.state().profile.titleTemplate, "Keep me");
});
