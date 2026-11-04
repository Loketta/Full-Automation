import crypto from "node:crypto";

export const CHANNEL_ANALYSIS_VERSION = 1;

export function buildChannelAnalysisExport(data, exportedAt = new Date().toISOString()) {
  const videos = (data.imports ?? []).map((video) => ({
    id: video.id,
    title: video.title,
    description: video.description,
    tags: Array.isArray(video.tags) ? video.tags : [],
    durationSeconds: video.duration,
    publishedAt: video.publishedAt,
  }));
  if (!videos.length) throw validation("Import the Beyond the Blackwall channel metadata before exporting it.");
  const datasetFingerprint = fingerprint(videos);
  return {
    version: CHANNEL_ANALYSIS_VERSION,
    channel: { id: data.channelId, name: "Beyond the Blackwall" },
    exportedAt,
    datasetFingerprint,
    videos,
  };
}

export function validateChannelAnalysisProposal(value, importedVideos) {
  const validated = validateChannelAnalysisDocument(value);
  const videos = (importedVideos ?? []).map((video) => ({ id: video.id, title: video.title, description: video.description, tags: Array.isArray(video.tags) ? video.tags : [], durationSeconds: video.duration, publishedAt: video.publishedAt }));
  if (!videos.length || validated.datasetFingerprint !== fingerprint(videos)) throw validation("The channel analysis does not match the currently imported metadata. Export the current dataset and review the analysis again.");
  const importedIds = new Set(videos.map((video) => video.id));
  const referenced = [...validated.report.observedConventions, ...validated.report.inconsistencies, ...validated.report.recommendations, ...validated.proposedProfile.genreProfiles].flatMap((item) => item.sourceVideoIds);
  if (referenced.some((id) => !importedIds.has(id))) throw validation("The analysis cites a video ID outside the reviewed export.");
  return validated;
}

export function validateChannelAnalysisDocument(value) {
  if (!plainObject(value) || value.version !== CHANNEL_ANALYSIS_VERSION) throw validation("The channel analysis must use schema version 1.");
  exactKeys(value, ["version", "channelId", "datasetFingerprint", "report", "proposedProfile"], "channel analysis");
  if (value.channelId !== "UCXO7g--zW3kReNXhcZNu_vg") throw validation("The channel analysis is not for Beyond the Blackwall.");
  if (!/^[a-f0-9]{64}$/.test(value.datasetFingerprint)) throw validation("The channel analysis has an invalid dataset fingerprint.");
  const { report, proposedProfile } = value;
  if (!plainObject(report) || !text(report.summary)) throw validation("The analysis report requires a summary.");
  exactKeys(report, ["summary", "observedConventions", "inconsistencies", "recommendations"], "analysis report");
  for (const key of ["observedConventions", "inconsistencies", "recommendations"]) if (!Array.isArray(report[key])) throw validation(`The analysis report requires ${key}.`);
  for (const item of report.observedConventions) {
    exactKeys(item, ["category", "pattern", "sourceVideoIds", "examples"], "observed convention");
    if (!plainObject(item) || !text(item.category) || !text(item.pattern) || !stringList(item.examples, 1) || !stringList(item.sourceVideoIds, 2)) throw validation("Every observed convention requires a category, pattern, example and at least two source video IDs.");
  }
  for (const item of report.inconsistencies) { exactKeys(item, ["issue", "sourceVideoIds"], "inconsistency"); if (!plainObject(item) || !text(item.issue) || !stringList(item.sourceVideoIds, 1)) throw validation("Every inconsistency requires an issue and source video IDs."); }
  for (const item of report.recommendations) { exactKeys(item, ["recommendation", "rationale", "sourceVideoIds"], "recommendation"); if (!plainObject(item) || !text(item.recommendation) || !text(item.rationale) || !Array.isArray(item.sourceVideoIds)) throw validation("Every recommendation requires text, rationale and a source-video list."); }
  if (!plainObject(proposedProfile) || !text(proposedProfile.compilationTitleTemplate) || !text(proposedProfile.individualTrackTitleTemplate)) throw validation("The proposed profile requires separate compilation and individual-track title templates.");
  exactKeys(proposedProfile, ["compilationTitleTemplate", "individualTrackTitleTemplate", "universalBranding", "universalTags", "universalHashtags", "genreProfiles"], "proposed profile");
  const branding = proposedProfile.universalBranding;
  exactKeys(branding, ["introduction", "footer", "callsToAction", "recurringLinks"], "universal branding");
  if (!plainObject(branding) || typeof branding.introduction !== "string" || typeof branding.footer !== "string" || !stringList(branding.callsToAction) || !stringList(branding.recurringLinks)) throw validation("The proposed profile has invalid universal branding.");
  if (!stringList(proposedProfile.universalTags) || !stringList(proposedProfile.universalHashtags) || !Array.isArray(proposedProfile.genreProfiles)) throw validation("The proposed profile has invalid universal tags, hashtags or genre profiles.");
  for (const item of proposedProfile.genreProfiles) { exactKeys(item, ["genre", "keywords", "tags", "hashtags", "sourceVideoIds"], "genre profile"); if (!plainObject(item) || !text(item.genre) || !stringList(item.keywords) || !stringList(item.tags) || !stringList(item.hashtags) || !stringList(item.sourceVideoIds, 1)) throw validation("A genre profile is invalid or lacks source evidence."); }
  return structuredClone(value);
}

export function fingerprint(videos) { return crypto.createHash("sha256").update(JSON.stringify(videos)).digest("hex"); }
function validation(message) { const error = new Error(message); error.name = "ChannelAnalysisValidationError"; error.statusCode = 400; return error; }
function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, allowed, label) { if (!plainObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw validation(`The ${label} contains unsupported fields.`); }
function text(value) { return typeof value === "string" && Boolean(value.trim()) && value.length <= 10000; }
function stringList(value, minimum = 0) { return Array.isArray(value) && value.length >= minimum && value.length <= 500 && value.every((item) => typeof item === "string" && item.trim() && item.length <= 2000); }
