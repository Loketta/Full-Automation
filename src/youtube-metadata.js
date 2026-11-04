import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { buildChannelAnalysisExport, validateChannelAnalysisProposal } from "./youtube-style-profile.js";

export const BEYOND_BLACKWALL_CHANNEL_ID = "UCXO7g--zW3kReNXhcZNu_vg";
const DATA_FILENAME = "youtube-channel-style.json";
const MAX_IMPORTED_VIDEOS = 500;

export class YouTubeMetadataStore {
  constructor(outputDirectory, dependencies = {}) {
    this.filePath = path.join(path.resolve(outputDirectory), DATA_FILENAME); this.outputDirectory = path.resolve(outputDirectory);
    this.fs = { mkdir: dependencies.mkdir ?? mkdir, readFile: dependencies.readFile ?? readFile, rename: dependencies.rename ?? rename, rm: dependencies.rm ?? rm, writeFile: dependencies.writeFile ?? writeFile };
    this.randomUUID = dependencies.randomUUID ?? crypto.randomUUID; this.data = emptyData(); this.queue = Promise.resolve();
  }
  initialize() { return this.#exclusive(async () => { await this.fs.mkdir(this.outputDirectory, { recursive: true }); try { const value = JSON.parse(await this.fs.readFile(this.filePath, "utf8")); if (value?.version !== 1) throw new Error("Unsupported metadata format."); this.data = { ...emptyData(), ...value, imports: value.imports ?? [], approvals: value.approvals ?? [] }; } catch (error) { if (error?.code !== "ENOENT") throw new MetadataPersistenceError(`YouTube metadata could not be loaded: ${error.message}`); } return this.get(); }); }
  get() { return structuredClone(this.data); }
  update(mutator) { return this.#exclusive(async () => { const next = structuredClone(this.data); mutator(next); const temporary = path.join(this.outputDirectory, `.youtube-metadata-${this.randomUUID()}.tmp`); try { await this.fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" }); await this.fs.rename(temporary, this.filePath); this.data = next; } catch (error) { await this.fs.rm(temporary, { force: true }).catch(() => {}); throw new MetadataPersistenceError("YouTube metadata could not be safely persisted."); } return this.get(); }); }
  #exclusive(operation) { const result = this.queue.then(operation, operation); this.queue = result.catch(() => {}); return result; }
}

export class YouTubeMetadataService {
  constructor({ connection, store, projects, library, mixStore, mixService, uploadService, compilationVideoService, now = () => new Date(), randomUUID = crypto.randomUUID }) { Object.assign(this, { connection, store, projects, library, mixStore, mixService, uploadService, compilationVideoService, now, randomUUID }); }
  initialize() { return this.store.initialize(); }
  state() { const data = this.store.get(); return { profile: data.profile, importedVideos: data.imports.map(publicImportedVideo), approvals: data.approvals, analysisProposal: data.analysisProposal }; }
  exportChannelAnalysis() { return buildChannelAnalysisExport(this.store.get(), this.now().toISOString()); }
  async importChannelAnalysis(input) {
    const data = this.store.get(); const validated = validateChannelAnalysisProposal(input, data.imports);
    const proposal = { ...validated, id: this.randomUUID(), importedAt: this.now().toISOString() };
    await this.store.update((next) => { next.analysisProposal = proposal; });
    return proposal;
  }
  async acceptChannelAnalysis(id) {
    const data = this.store.get(); const proposal = data.analysisProposal; if (!proposal || proposal.id !== id) throw new MetadataConflictError("The channel-style proposal is missing or changed. Import and review it again.");
    validateChannelAnalysisProposal({ version: proposal.version, channelId: proposal.channelId, datasetFingerprint: proposal.datasetFingerprint, report: proposal.report, proposedProfile: proposal.proposedProfile }, data.imports);
    const proposed = proposal.proposedProfile; const current = data.profile ?? {};
    const profile = validateProfile({ ...current, titleTemplate: proposed.compilationTitleTemplate, compilationTitleTemplate: proposed.compilationTitleTemplate, individualTrackTitleTemplate: proposed.individualTrackTitleTemplate, introduction: proposed.universalBranding.introduction, footer: proposed.universalBranding.footer, reusableText: proposed.universalBranding.callsToAction.join("\n"), links: proposed.universalBranding.recurringLinks, genreVocabulary: proposed.genreProfiles.flatMap((item) => item.keywords), tags: proposed.universalTags, hashtags: proposed.universalHashtags, genreProfiles: proposed.genreProfiles });
    const evidenceIds = [...new Set(proposal.report.observedConventions.flatMap((item) => item.sourceVideoIds))];
    await this.store.update((next) => { next.profile = { ...profile, informedByVideoIds: evidenceIds, findings: proposal.report.observedConventions.map((item) => `${item.category}: ${item.pattern}`), analysisReport: proposal.report, analysisProposalId: proposal.id, userEdited: true, updatedAt: this.now().toISOString() }; next.analysisProposal = undefined; }); return this.state().profile;
  }

  async importChannel() {
    const context = await this.connection.getVerifiedReadContext();
    if (context.channel.id !== BEYOND_BLACKWALL_CHANNEL_ID) throw new MetadataConflictError(`Connect the Beyond the Blackwall channel (${BEYOND_BLACKWALL_CHANNEL_ID}) before importing style.`);
    const channelResponse = await callYouTube(() => context.youtube.channels.list({ part: ["snippet", "contentDetails"], mine: true, maxResults: 50 }));
    const channel = (channelResponse?.data?.items ?? []).find((item) => item.id === BEYOND_BLACKWALL_CHANNEL_ID);
    const uploadsPlaylist = channel?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylist) throw new MetadataValidationError("The authorized channel did not provide an uploads playlist.");
    const playlistItems = []; let pageToken;
    do {
      const response = await callYouTube(() => context.youtube.playlistItems.list({ part: ["contentDetails", "snippet"], playlistId: uploadsPlaylist, maxResults: 50, pageToken }));
      playlistItems.push(...(response?.data?.items ?? [])); pageToken = response?.data?.nextPageToken;
      if (playlistItems.length > MAX_IMPORTED_VIDEOS) throw new MetadataValidationError(`Channel import is limited to ${MAX_IMPORTED_VIDEOS} videos.`);
    } while (pageToken);
    const ids = playlistItems.map((item) => item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId).filter(Boolean);
    const videos = [];
    for (let index = 0; index < ids.length; index += 50) {
      const response = await callYouTube(() => context.youtube.videos.list({ part: ["snippet", "contentDetails"], id: ids.slice(index, index + 50), maxResults: 50 }));
      videos.push(...(response?.data?.items ?? []).map(normalizeVideo));
    }
    const profile = analyseChannelStyle(videos);
    const importedAt = this.now().toISOString();
    await this.store.update((data) => { data.channelId = BEYOND_BLACKWALL_CHANNEL_ID; data.imports = videos; data.importedAt = importedAt; data.profile = mergeProfile(profile, data.profile?.userEdited ? data.profile : undefined); });
    return this.state();
  }

  async saveProfile(input) {
    const profile = validateProfile(input); await this.store.update((data) => { data.profile = { ...profile, informedByVideoIds: data.profile?.informedByVideoIds ?? [], findings: data.profile?.findings ?? [], userEdited: true, updatedAt: this.now().toISOString() }; }); return this.state().profile;
  }

  async generate({ projectId, mixId, sourceFilename }) {
    const profile = this.store.get().profile; if (!profile) throw new MetadataValidationError("Import or create a channel style profile first.");
    const project = this.projects.get(projectId); const mix = this.mixStore.get(mixId); const source = await this.uploadService.describeSource(sourceFilename);
    const provenance = this.compilationVideoService?.getExportProvenance(sourceFilename);
    if (!provenance?.mixId || !provenance?.mixExportSnapshot || !Array.isArray(provenance.timeline)) throw new MetadataValidationError("This compilation MP4 predates reliable mix provenance. Automated chapters are unavailable; use manual metadata, or safely re-render the video from its completed WAV with the current application.");
    if (provenance.outputFingerprint !== source.fingerprint) throw new MetadataConflictError("The compilation MP4 no longer matches its saved render provenance. Automated chapters were not generated.");
    if (provenance.mixId !== mixId) throw new MetadataConflictError("The selected compilation MP4 was rendered from a different audio mix. Select its recorded source mix.");
    const mixExport = (mix.exports ?? []).find((item) => item.snapshot === provenance.mixExportSnapshot && item.filename === provenance.masterFilename);
    if (!mixExport?.timeline || JSON.stringify(mixExport.timeline) !== JSON.stringify(provenance.timeline)) throw new MetadataConflictError("The compilation provenance no longer matches the retained WAV mix export timeline.");
    const authoritativeTimeline = validateCompletedTimeline(provenance.timeline, source.duration, provenance.duration);
    const projectTracks = new Map(project.tracks.filter((track) => track.libraryTrackId).map((track) => [track.libraryTrackId, track]));
    const tracks = authoritativeTimeline.map((track) => ({ id: track.trackId, title: track.title, duration: track.duration, startSeconds: track.startSeconds, projectTrack: projectTracks.get(track.trackId) }));
    const missing = tracks.filter((track) => !track.projectTrack).map((track) => track.title);
    if (missing.length) throw new MetadataValidationError(`The selected mix contains recordings not linked to the selected project: ${missing.join(", ")}.`);
    const notAccepted = tracks.filter((track) => this.library?.get(track.id)?.reviewStatus !== "Keep").map((track) => track.projectTrack.title);
    if (notAccepted.length) throw new MetadataValidationError(`Every compilation chapter must use an accepted recording. Review these tracks first: ${notAccepted.join(", ")}.`);
    const timeline = tracks.map((track) => ({ trackId: track.id, title: track.projectTrack.title, startSeconds: track.startSeconds }));
    const durationText = describeDuration(source.duration); const genre = project.theme?.trim();
    if (!genre) throw new MetadataValidationError("The selected project has no theme/genre description.");
    const title = applyTemplate(profile.compilationTitleTemplate || profile.titleTemplate || "{project} — {duration} Mix", { project: project.name, duration: durationText, genre: firstSentence(genre) }).slice(0, 100);
    const chapters = formatChapters(timeline); const hashtags = profile.hashtags.join(" ");
    const sections = [profile.introduction, `${project.name}\n${genre}`, `Tracklist\n${chapters}`, profile.reusableText, profile.links.join("\n"), profile.footer, hashtags].map((value) => String(value ?? "").trim()).filter(Boolean);
    const description = sections.join("\n\n"); if (description.length > 5000) throw new MetadataValidationError("Generated description exceeds YouTube's 5,000-character limit. Shorten the saved profile text.");
    const tags = [...new Set([...profile.tags, ...profile.genreVocabulary, ...wordsFromTheme(genre)])].filter(Boolean); while (tags.join(",").length > 500) tags.pop();
    const inputSnapshot = metadataSnapshot({ project, mix, source, timeline, profile });
    return { projectId, mixId, source, title, description, tags, chapters, timeline, channelId: BEYOND_BLACKWALL_CHANNEL_ID, inputSnapshot };
  }

  async approve(input) {
    const generated = await this.generate(input); if (generated.inputSnapshot !== input.inputSnapshot) throw new MetadataConflictError("The source, project, mix, timeline, or style profile changed. Generate and review metadata again.");
    const metadata = validateMetadataEdits(input); const approval = { id: crypto.randomUUID(), projectId: generated.projectId, mixId: generated.mixId, sourceFilename: generated.source.filename, sourceFingerprint: generated.source.fingerprint, inputSnapshot: generated.inputSnapshot, title: metadata.title, description: metadata.description, tags: metadata.tags, approvedAt: this.now().toISOString() };
    await this.store.update((data) => { data.approvals = data.approvals.filter((item) => !(item.projectId === approval.projectId && item.sourceFilename === approval.sourceFilename)); data.approvals.push(approval); }); return approval;
  }
}

export function analyseChannelStyle(videos) {
  const valid = videos.filter((video) => video.title); const informedByVideoIds = valid.map((video) => video.id); const enough = valid.length >= 2;
  const titleSuffix = enough ? commonValue(valid.map((video) => titleAffix(video.title, "suffix"))) : "";
  const intros = valid.map((video) => paragraph(video.description, 0)); const footers = valid.map((video) => paragraph(video.description, -1));
  const tags = frequent(valid.flatMap((video) => video.tags), valid.length); const hashtags = frequent(valid.flatMap((video) => video.description.match(/#[\p{L}\p{N}_-]+/gu) ?? []), valid.length);
  const links = frequent(valid.flatMap((video) => video.description.match(/https?:\/\/[^\s)]+/g) ?? []), valid.length);
  const genreVocabulary = frequent(valid.flatMap((video) => video.tags.filter((tag) => /ambient|cyber|industrial|synth|dark|electronic|music|soundtrack|mix/i.test(tag))), valid.length);
  const durationTerminology = frequent(valid.flatMap((video) => `${video.title} ${video.description}`.match(/\b(?:\d+\s*)?(?:hour|hours|minute|minutes|full-length|extended|compilation|mix)\b/gi) ?? []), valid.length);
  const findings = enough ? [`Analysed ${valid.length} videos.`, titleSuffix ? `Recurring title suffix: ${titleSuffix}` : "No recurring title suffix was established."] : ["Insufficient channel history to infer recurring conventions; edit the blank profile fields manually."];
  return { titleTemplate: titleSuffix ? `{project} ${titleSuffix}` : "{project} — {duration} {genre} Mix", introduction: enough ? commonValue(intros) : "", footer: enough ? commonValue(footers) : "", reusableText: "", links, genreVocabulary, durationTerminology, tags, hashtags, thumbnailBranding: enough ? commonThumbnailHost(valid) : "", informedByVideoIds, findings, userEdited: false };
}

export function buildChapterTimeline(tracks, transitions) {
  if (!Array.isArray(tracks) || tracks.length < 3) throw new MetadataValidationError("YouTube chapters require at least three tracks with authoritative timing.");
  const timeline = []; let start = 0;
  tracks.forEach((track, index) => { if (!Number.isFinite(track.duration) || track.duration <= 0) throw new MetadataValidationError("Every chapter requires a valid source duration."); timeline.push({ trackId: track.id, title: track.projectTrack?.title ?? track.title, startSeconds: start }); if (index < tracks.length - 1) start += track.duration - Number(transitions[index]?.duration ?? 0); });
  if (timeline[0].startSeconds !== 0 || timeline.some((item, index) => index && item.startSeconds - timeline[index - 1].startSeconds < 10)) throw new MetadataValidationError("YouTube chapters must begin at 00:00 and each chapter must be at least 10 seconds long."); return timeline;
}
export function validateCompletedTimeline(timeline, videoDuration, recordedDuration, tolerance = 2) {
  if (!Array.isArray(timeline) || timeline.length < 3) throw new MetadataValidationError("The completed video does not have at least three authoritative timeline entries.");
  if (!Number.isFinite(videoDuration) || videoDuration <= 0 || !Number.isFinite(recordedDuration) || Math.abs(recordedDuration - videoDuration) > tolerance) throw new MetadataConflictError("The completed video's duration does not match its recorded compilation provenance.");
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index]; if (typeof item.trackId !== "string" || !Number.isFinite(item.startSeconds) || !Number.isFinite(item.duration) || item.duration <= 0) throw new MetadataValidationError("The retained mix timeline is incomplete or invalid.");
    if (index === 0 && item.startSeconds !== 0) throw new MetadataValidationError("The authoritative chapter timeline must begin at 00:00.");
    if (index > 0 && item.startSeconds - timeline[index - 1].startSeconds < 10) throw new MetadataValidationError("Every authoritative chapter must be at least 10 seconds long.");
    if (item.startSeconds < 0 || item.startSeconds >= videoDuration) throw new MetadataValidationError("A chapter timestamp falls outside the completed video duration.");
  }
  const last = timeline.at(-1); if (videoDuration - last.startSeconds < 10) throw new MetadataValidationError("The final chapter must last at least 10 seconds.");
  if (Math.abs(last.startSeconds + last.duration - videoDuration) > tolerance) throw new MetadataConflictError("The retained mix timeline does not end with the completed video duration.");
  return structuredClone(timeline);
}
export function formatChapters(timeline) { return timeline.map((item) => `${formatTimestamp(item.startSeconds)} ${item.title}`).join("\n"); }

function normalizeVideo(item) { const snippet = item.snippet ?? {}; return { id: item.id, title: snippet.title ?? "", description: snippet.description ?? "", tags: Array.isArray(snippet.tags) ? snippet.tags : [], thumbnailUrl: snippet.thumbnails?.maxres?.url ?? snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url, publishedAt: snippet.publishedAt, duration: parseIsoDuration(item.contentDetails?.duration) }; }
function publicImportedVideo(video) { return { id: video.id, title: video.title, thumbnailUrl: video.thumbnailUrl, publishedAt: video.publishedAt, duration: video.duration }; }
function emptyData() { return { version: 1, channelId: BEYOND_BLACKWALL_CHANNEL_ID, imports: [], profile: undefined, approvals: [] }; }
function validateProfile(value) { const text = (key, max = 5000) => { const result = String(value?.[key] ?? "").trim(); if (result.length > max) throw new MetadataValidationError(`${key} is too long.`); return result; }; const list = (key) => [...new Set((Array.isArray(value?.[key]) ? value[key] : String(value?.[key] ?? "").split(/[,\n]/)).map((item) => String(item).trim()).filter(Boolean))]; return { titleTemplate: text("titleTemplate", 200), compilationTitleTemplate: text("compilationTitleTemplate", 200), individualTrackTitleTemplate: text("individualTrackTitleTemplate", 200), introduction: text("introduction"), footer: text("footer"), reusableText: text("reusableText"), thumbnailBranding: text("thumbnailBranding", 500), links: list("links"), genreVocabulary: list("genreVocabulary"), durationTerminology: list("durationTerminology"), tags: list("tags"), hashtags: list("hashtags"), genreProfiles: Array.isArray(value?.genreProfiles) ? structuredClone(value.genreProfiles) : [] }; }
function mergeProfile(inferred, existing) { return existing ? { ...inferred, ...validateProfile(existing), informedByVideoIds: inferred.informedByVideoIds, findings: inferred.findings, userEdited: true } : inferred; }
function validateMetadataEdits(value) { const title = String(value.title ?? "").trim(); const description = String(value.description ?? "").trim(); const tags = (Array.isArray(value.tags) ? value.tags : String(value.tags ?? "").split(",")).map((tag) => String(tag).trim()).filter(Boolean); if (!title || title.length > 100) throw new MetadataValidationError("YouTube title must contain 1–100 characters."); if (description.length > 5000) throw new MetadataValidationError("YouTube description exceeds 5,000 characters."); if (tags.join(",").length > 500) throw new MetadataValidationError("YouTube tags exceed 500 characters."); return { title, description, tags }; }
function metadataSnapshot(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function applyTemplate(template, values) { return template.replace(/\{(project|duration|genre)\}/g, (_match, key) => values[key] ?? "").replace(/\s+/g, " ").trim(); }
function describeDuration(seconds) { const minutes = Math.round(seconds / 60); return minutes >= 60 ? `${Math.floor(minutes / 60)} Hour${minutes >= 120 ? "s" : ""}` : `${minutes} Minute`; }
function firstSentence(value) { return String(value).split(/[.!?]/)[0].trim(); }
function wordsFromTheme(value) { return String(value).toLowerCase().match(/[a-z0-9-]{4,}/g)?.slice(0, 10) ?? []; }
function paragraph(value, index) { const values = String(value ?? "").split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean); return values.at(index) ?? ""; }
function titleAffix(title, side) { const parts = String(title).split(/\s(?:\||—|-)\s/); return parts.length > 1 ? (side === "suffix" ? `${title.includes(" | ") ? "|" : title.includes(" — ") ? "—" : "-"} ${parts.at(-1)}` : parts[0]) : ""; }
function commonValue(values) { const counts = new Map(); for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1); const winner = [...counts].sort((a, b) => b[1] - a[1])[0]; return winner && winner[1] >= 2 ? winner[0] : ""; }
function frequent(values, videoCount) { const counts = new Map(); for (const raw of values) { const value = String(raw).trim(); if (value) counts.set(value, (counts.get(value) ?? 0) + 1); } return [...counts].filter(([, count]) => count >= Math.max(2, Math.ceil(videoCount / 2))).sort((a, b) => b[1] - a[1]).map(([value]) => value); }
function commonThumbnailHost(videos) { const hosts = videos.map((video) => { try { return new URL(video.thumbnailUrl).host; } catch { return ""; } }); return commonValue(hosts); }
async function callYouTube(operation) { try { return await operation(); } catch (error) { const status = Number(error?.code ?? error?.response?.status); if (status === 401) throw new MetadataExternalError("YouTube authorization was revoked or expired. Reconnect the intended channel and try again."); if (status === 403 || status === 429) throw new MetadataExternalError("YouTube channel metadata could not be imported because the API quota or access policy rejected the request. No saved profile was changed."); throw new MetadataExternalError("YouTube channel metadata could not be retrieved. No saved profile was changed; try the manual refresh again later."); } }
function parseIsoDuration(value = "") { const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value); return match ? Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0) : undefined; }
function formatTimestamp(seconds) { const value = Math.floor(seconds); const hours = Math.floor(value / 3600); const minutes = Math.floor((value % 3600) / 60); const secs = String(value % 60).padStart(2, "0"); return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${String(minutes).padStart(2, "0")}:${secs}`; }

export class MetadataValidationError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class MetadataConflictError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class MetadataPersistenceError extends Error { constructor(message) { super(message); this.statusCode = 500; } }
export class MetadataExternalError extends Error { constructor(message) { super(message); this.statusCode = 502; } }
