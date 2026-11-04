import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { YouTubeMetadataStore } from "../src/youtube-metadata.js";
import { buildAnalysisInput, estimateTokens, STYLE_ANALYSIS_SCHEMA, validateAiAnalysis, YouTubeStyleAiService } from "../src/youtube-style-ai.js";

function videos(count = 6) { return Array.from({ length: count }, (_, index) => ({ id: `video-${index}`, title: index % 2 ? `Track ${index}` : `Compilation ${index}`, description: `Public description ${index}\nhttps://example.test`, tags: ["cyberpunk", index % 2 ? "track" : "mix"], duration: 3600 + index, publishedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`, privateField: "must-not-send" })); }
function response(overrides = {}) { return { report: { summary: "Observed two formats.", observedConventions: [{ category: "titles", pattern: "Compilations include Mix", sourceVideoIds: ["video-0", "video-2"], examples: ["Compilation 0"] }], inconsistencies: [{ issue: "Mixed separators", sourceVideoIds: ["video-1"] }], recommendations: [{ recommendation: "Use one separator", rationale: "Consistency", sourceVideoIds: ["video-0", "video-1"] }] }, proposedProfile: { compilationTitleTemplate: "{project} | {duration} Cyberpunk Mix", individualTrackTitleTemplate: "{track} | Cyberpunk", universalBranding: { introduction: "Beyond the Blackwall", footer: "Subscribe", callsToAction: ["Subscribe"], recurringLinks: ["https://example.test"] }, universalTags: ["cyberpunk music"], universalHashtags: ["#BeyondTheBlackwall"], genreProfiles: [{ genre: "cyberpunk", keywords: ["industrial"], tags: ["dark cyberpunk"], hashtags: ["#Cyberpunk"], sourceVideoIds: ["video-0", "video-2"] }] }, ...overrides }; }
async function fixture(t, options = {}) { const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-style-ai-")); t.after(() => rm(root, { recursive: true, force: true })); const store = new YouTubeMetadataStore(root); await store.initialize(); await store.update((data) => { data.imports = options.videos ?? videos(); data.profile = { titleTemplate: "Manual template", introduction: "Manual intro", userEdited: true }; }); const calls = []; const client = options.client ?? { interactions: { async create(args) { calls.push(args); return { output_text: JSON.stringify(response()) }; } } }; const service = new YouTubeStyleAiService({ client, store, randomUUID: () => "plan-id", now: () => 1_800_000_000_000, maxInputTokens: options.maxInputTokens ?? 100000, inputUsdPerMillion: options.inputRate, outputUsdPerMillion: options.outputRate }); return { root, store, calls, service }; }

test("plans from saved imported metadata and makes exactly one structured Gemini request", async (t) => {
  const values = await fixture(t, { inputRate: 0.25, outputRate: 1.5 }); const plan = values.service.plan(); assert.equal(plan.model, "gemini-3.1-flash-lite"); assert.equal(plan.videoCount, 6); assert.equal(plan.maximumBillableRequests, 1); assert.ok(plan.estimatedInputTokens > 0); assert.ok(plan.estimatedMaximumCostUsd > 0);
  const proposal = await values.service.analyse(plan.snapshot); assert.equal(values.calls.length, 1); assert.equal(values.calls[0].model, "gemini-3.1-flash-lite"); assert.deepEqual(values.calls[0].response_format, { type: "text", mime_type: "application/json", schema: STYLE_ANALYSIS_SCHEMA }); assert.equal(proposal.report.observedConventions[0].sourceVideoIds[0], "video-0");
  assert.doesNotMatch(values.calls[0].input, /must-not-send|oauth|refresh_token/i); await assert.rejects(() => values.service.analyse(plan.snapshot), /already used/); assert.equal(values.calls.length, 1);
});

test("oversized and insufficient datasets are rejected before any billable request", async (t) => {
  const oversized = await fixture(t, { maxInputTokens: 10 }); const plan = oversized.service.plan(); assert.equal(plan.oversized, true); await assert.rejects(() => oversized.service.analyse(plan.snapshot), /maximum input tokens/); assert.equal(oversized.calls.length, 0);
  const insufficient = await fixture(t, { videos: videos(4) }); assert.throws(() => insufficient.service.plan(), /At least five/); assert.equal(insufficient.calls.length, 0);
});

test("provider failures are not retried and malformed or unsupported evidence is rejected", async (t) => {
  let attempts = 0; const failed = await fixture(t, { client: { interactions: { async create() { attempts += 1; throw new Error("provider down"); } } } }); const plan = failed.service.plan(); await assert.rejects(() => failed.service.analyse(plan.snapshot), /No automatic retry/); assert.equal(attempts, 1);
  const malformed = response(); malformed.report.summary = ""; assert.throws(() => validateAiAnalysis(malformed, new Set(videos().map((item) => item.id))), /incomplete/);
  const invented = response(); invented.report.observedConventions[0].sourceVideoIds = ["not-imported"]; assert.throws(() => validateAiAnalysis(invented, new Set(videos().map((item) => item.id))), /not included/);
});

test("token input contains only approved public channel fields", () => { const input = buildAnalysisInput(videos(5)); assert.ok(estimateTokens(input) > 0); assert.doesNotMatch(input, /must-not-send/); assert.match(input, /durationSeconds/); assert.match(input, /publishedAt/); });
