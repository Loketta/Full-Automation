import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildChannelAnalysisExport, validateChannelAnalysisDocument, validateChannelAnalysisProposal } from "../src/youtube-style-profile.js";

const videos = [{ id: "v1", title: "Mix One", description: "Public description", tags: ["cyberpunk"], duration: 3600, publishedAt: "2026-01-01T00:00:00Z", refreshToken: "secret" }, { id: "v2", title: "Track Two", description: "Another description", tags: ["industrial"], duration: 240, publishedAt: "2026-01-02T00:00:00Z" }];
function proposal(datasetFingerprint) { return { version: 1, channelId: "UCXO7g--zW3kReNXhcZNu_vg", datasetFingerprint, report: { summary: "Two formats", observedConventions: [{ category: "titles", pattern: "Mix and track formats", sourceVideoIds: ["v1", "v2"], examples: ["Mix One"] }], inconsistencies: [{ issue: "Separators vary", sourceVideoIds: ["v1"] }], recommendations: [{ recommendation: "Use one separator", rationale: "Consistency", sourceVideoIds: ["v1", "v2"] }] }, proposedProfile: { compilationTitleTemplate: "{project} | Mix", individualTrackTitleTemplate: "{track} | Track", universalBranding: { introduction: "Beyond the Blackwall", footer: "Subscribe", callsToAction: ["Subscribe"], recurringLinks: ["https://example.test"] }, universalTags: ["music"], universalHashtags: ["#Blackwall"], genreProfiles: [{ genre: "industrial", keywords: ["dark"], tags: ["industrial"], hashtags: ["#Industrial"], sourceVideoIds: ["v1", "v2"] }] } }; }

test("exports only reviewable imported channel metadata", () => {
  const exported = buildChannelAnalysisExport({ channelId: "UCXO7g--zW3kReNXhcZNu_vg", imports: videos }, "2026-11-04T00:00:00Z");
  assert.equal(exported.version, 1); assert.equal(exported.videos.length, 2); assert.deepEqual(Object.keys(exported.videos[0]), ["id", "title", "description", "tags", "durationSeconds", "publishedAt"]);
  assert.doesNotMatch(JSON.stringify(exported), /secret|refreshToken|oauth/i);
});

test("strictly validates reviewed profiles against the exact exported dataset", () => {
  const exported = buildChannelAnalysisExport({ channelId: "UCXO7g--zW3kReNXhcZNu_vg", imports: videos });
  assert.equal(validateChannelAnalysisProposal(proposal(exported.datasetFingerprint), videos).report.summary, "Two formats");
  assert.throws(() => validateChannelAnalysisProposal(proposal("0".repeat(64)), videos), /does not match/);
  const invented = proposal(exported.datasetFingerprint); invented.report.observedConventions[0].sourceVideoIds[0] = "invented"; assert.throws(() => validateChannelAnalysisProposal(invented, videos), /outside/);
  const malformed = proposal(exported.datasetFingerprint); delete malformed.proposedProfile.individualTrackTitleTemplate; assert.throws(() => validateChannelAnalysisProposal(malformed, videos), /separate/);
  const unrelated = proposal(exported.datasetFingerprint); unrelated.oauthCredentials = { accessToken: "no" }; assert.throws(() => validateChannelAnalysisProposal(unrelated, videos), /unsupported fields/);
});

test("bundled Beyond the Blackwall analysis is valid schema-v1 reviewed JSON", async () => {
  const bundled = JSON.parse(await readFile("channel-analysis/beyond-the-blackwall-analysis.json", "utf8"));
  const validated = validateChannelAnalysisDocument(bundled);
  assert.equal(validated.channelId, "UCXO7g--zW3kReNXhcZNu_vg"); assert.equal(validated.datasetFingerprint, "2f7b83f65211ae023d0c1c76502e917df2db052b3879a53c62e5cfdcf454ba27");
  assert.equal(validated.report.observedConventions.length, 8); assert.equal(validated.proposedProfile.compilationTitleTemplate, "{project} || {genre} Mix ({duration})");
});
