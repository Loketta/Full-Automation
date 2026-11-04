import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { buildChannelAnalysisExport, validateChannelAnalysisDocument, validateChannelAnalysisProposal } from "./youtube-style-profile.js";
import { COMPILATION_TEMPLATE_VARIABLES, DESCRIPTION_TEMPLATE_VARIABLES, genreLabel, groundedScene, profileHashtags, profileKeywords, relevantUses, renderOptionalTemplate, renderTemplate, selectGenreProfiles, TRACK_TEMPLATE_VARIABLES, validateTemplate } from "./youtube-metadata-engine.js";

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
  constructor({ connection, store, projects, library, mixStore, mixService, uploadService, compilationVideoService, bundledAnalysisPath, now = () => new Date(), randomUUID = crypto.randomUUID }) { Object.assign(this, { connection, store, projects, library, mixStore, mixService, uploadService, compilationVideoService, bundledAnalysisPath, now, randomUUID }); this.bundledAnalysis = undefined; this.bundledAnalysisStatus = { available: false, compatible: false, applied: false }; }
  async initialize() { await this.store.initialize(); await this.loadBundledAnalysis(); return this.state(); }
  state() { const data = this.store.get(); return { profile: data.profile, importedVideos: data.imports.map(publicImportedVideo), approvals: data.approvals, analysisProposal: data.analysisProposal, bundledAnalysis: this.bundledAnalysisStatus }; }
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
    await this.store.update((next) => { next.profile = { ...profile, informedByVideoIds: evidenceIds, findings: proposal.report.observedConventions.map((item) => `${item.category}: ${item.pattern}`), analysisReport: proposal.report, analysisProposalId: proposal.id, userEdited: true, updatedAt: this.now().toISOString() }; next.analysisProposal = undefined; if (proposal.origin === "bundled") next.bundledAnalysisApprovals = [...new Set([...(next.bundledAnalysisApprovals ?? []), proposal.datasetFingerprint])]; });
    if (proposal.origin === "bundled") this.bundledAnalysisStatus = { ...this.bundledAnalysisStatus, applied: true, message: "The bundled channel analysis has been approved and applied." };
    return this.state().profile;
  }

  async loadBundledAnalysis() {
    if (!this.bundledAnalysisPath) return;
    try { this.bundledAnalysis = validateChannelAnalysisDocument(JSON.parse(await readFile(this.bundledAnalysisPath, "utf8"))); }
    catch (error) { if (error?.code === "ENOENT") return; throw new MetadataPersistenceError(`Bundled channel analysis could not be loaded: ${error.message}`); }
    await this.stageBundledAnalysis();
  }

  async stageBundledAnalysis() {
    if (!this.bundledAnalysis) return;
    const data = this.store.get();
    try { validateChannelAnalysisProposal(this.bundledAnalysis, data.imports); }
    catch (error) { this.bundledAnalysisStatus = { available: true, compatible: false, applied: false, message: data.imports.length ? error.message : "Import the Beyond the Blackwall metadata to verify and preview the bundled analysis." }; return; }
    const applied = (data.bundledAnalysisApprovals ?? []).includes(this.bundledAnalysis.datasetFingerprint);
    this.bundledAnalysisStatus = { available: true, compatible: true, applied, message: applied ? "The bundled channel analysis has already been approved and applied." : "A bundled reviewed analysis matches the imported channel metadata and is ready for approval." };
    if (!applied && !data.analysisProposal) await this.store.update((next) => { next.analysisProposal = { ...this.bundledAnalysis, id: `bundled:${this.bundledAnalysis.datasetFingerprint}`, origin: "bundled", importedAt: this.now().toISOString() }; });
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
    await this.stageBundledAnalysis();
    return this.state();
  }

  async saveProfile(input) {
    const profile = validateProfile(input); await this.store.update((data) => { data.profile = { ...profile, informedByVideoIds: data.profile?.informedByVideoIds ?? [], findings: data.profile?.findings ?? [], userEdited: true, updatedAt: this.now().toISOString() }; }); return this.state().profile;
  }

  async generate({ projectId, mixId, sourceFilename }) {
    const profile = this.store.get().profile; if (!profile) throw new MetadataValidationError("Import or create a channel style profile first.");
    const project = this.projects.get(projectId); const mix = this.mixStore.get(mixId); const source = await this.uploadService.describeSource(sourceFilename);
    const provenance = this.compilationVideoService?.getExportProvenance(sourceFilename);
    let authoritativeTimeline; let chapterWarning = "";
    if (!provenance) chapterWarning = "No saved MP4 provenance record exists. Metadata was generated without chapters; no timestamps were guessed.";
    else {
      if (!provenance.outputFingerprint) chapterWarning = "The MP4 provenance record has no source fingerprint. Metadata was generated without chapters.";
      else if (provenance.outputFingerprint !== source.fingerprint) throw new MetadataConflictError("The compilation MP4 fingerprint conflicts with its saved provenance. Metadata was not generated.");
      if (provenance.mixId && provenance.mixId !== mixId) throw new MetadataConflictError("The selected compilation MP4 was rendered from a different audio mix. Select its recorded source mix.");
      if (provenance.mixId && provenance.mixExportSnapshot && Array.isArray(provenance.timeline)) {
        const mixExport = (mix.exports ?? []).find((item) => item.snapshot === provenance.mixExportSnapshot && item.filename === provenance.masterFilename);
        if (!mixExport?.timeline || JSON.stringify(mixExport.timeline) !== JSON.stringify(provenance.timeline)) throw new MetadataConflictError("The compilation provenance conflicts with the retained WAV mix export timeline.");
        authoritativeTimeline = validateCompletedTimeline(provenance.timeline, source.duration, provenance.duration);
      } else chapterWarning ||= provenance.provenanceDiagnostic || "The MP4 provenance is incomplete. Metadata was generated without chapters; no timestamps were guessed.";
    }
    const projectTracks = new Map(project.tracks.filter((track) => track.libraryTrackId).map((track) => [track.libraryTrackId, track]));
    const evidenceTrackIds = authoritativeTimeline?.map((item) => item.trackId) ?? mix.trackIds ?? []; const tracks = (authoritativeTimeline ?? []).map((track) => ({ id: track.trackId, title: track.title, duration: track.duration, startSeconds: track.startSeconds, projectTrack: projectTracks.get(track.trackId) }));
    const linkageDiagnostics = diagnoseProjectMixLinks({ project, mix, recordingIds: evidenceTrackIds, projects: this.projects, library: this.library });
    if (linkageDiagnostics.status === "conflict") throw new MetadataConflictError(`${linkageDiagnostics.message} ${formatMissingRecordings(linkageDiagnostics.missingRecordings)}`);
    if (linkageDiagnostics.missingRecordings.length && authoritativeTimeline) throw new MetadataConflictError(`Verified chapters require verified project links. ${formatMissingRecordings(linkageDiagnostics.missingRecordings)} Review an evidence-backed repair before generating chapters.`);
    if (linkageDiagnostics.missingRecordings.length) chapterWarning = `${chapterWarning} Project linkage is unverified for ${formatMissingRecordings(linkageDiagnostics.missingRecordings)} Metadata was generated without chapters.`.trim();
    const missing = tracks.filter((track) => !track.projectTrack).map((track) => track.title);
    if (missing.length) throw new MetadataValidationError(`The selected mix contains recordings not linked to the selected project: ${missing.join(", ")}.`);
    const notAccepted = evidenceTrackIds.filter((id) => this.library?.get(id)?.reviewStatus !== "Keep").map((id) => projectTracks.get(id)?.title ?? id);
    if (notAccepted.length) throw new MetadataValidationError(`Every compilation chapter must use an accepted recording. Review these tracks first: ${notAccepted.join(", ")}.`);
    const timeline = tracks.map((track) => ({ trackId: track.id, title: track.projectTrack.title, startSeconds: track.startSeconds }));
    const theme = project.theme?.trim(); if (!theme) throw new MetadataValidationError("The selected project has no theme information.");
    const selectedGenres = selectGenreProfiles(project, profile.genreProfiles); const selectedGenreNames = selectedGenres.map((item) => item.genre); const genre = genreLabel(selectedGenres); const scene = groundedScene(project);
    const variables = { project: project.name, duration: describeDuration(source.duration), genre, mood_or_scene: scene };
    const title = renderTemplate(profile.compilationTitleTemplate || profile.titleTemplate || "{project} — {duration} Mix", variables, COMPILATION_TEMPLATE_VARIABLES, "Compilation title template");
    if (title.length > 100) throw new MetadataValidationError(`Generated title is ${title.length} characters; YouTube allows 100. Shorten the project name or compilation template.`);
    const chapters = timeline.length ? formatChapters(timeline) : ""; const renderedIntroduction = profile.introduction ? renderOptionalTemplate(profile.introduction, variables, DESCRIPTION_TEMPLATE_VARIABLES, "Introduction template") : { text: scene ? `Music for ${scene}.` : "", warning: "" }; const introduction = renderedIntroduction.text;
    const uses = relevantUses(project); const style = `${project.name} brings together ${genre.toLowerCase()} music grounded in the project's saved theme: ${theme}`; const listening = uses.length ? `Suitable for ${naturalList(uses)}.` : "";
    const hashtags = [...new Set([...(profile.hashtags ?? []), ...profileHashtags(selectedGenres)])].slice(0, 6).join(" ");
    const sections = [introduction, `${style}. ${listening}`.trim(), chapters ? `Tracklist\n${chapters}` : "", profile.reusableText, profile.links.join("\n"), profile.footer, hashtags].map((value) => String(value ?? "").trim()).filter(Boolean);
    const description = sections.join("\n\n"); if (description.length > 5000) throw new MetadataValidationError("Generated description exceeds YouTube's 5,000-character limit. Shorten the saved profile text.");
    const tags = [...new Set([...(profile.tags ?? []), ...(profile.genreVocabulary ?? []), ...profileKeywords(selectedGenres), ...wordsFromTheme(theme)])].filter(Boolean); while (tags.join(",").length > 500) tags.pop();
    const inputSnapshot = metadataSnapshot({ project, mix, source, provenance, linkageDiagnostics, timeline, profile });
    return { kind: "compilation", projectId, mixId, source, title, description, tags, hashtags: [...new Set([...(profile.hashtags ?? []), ...profileHashtags(selectedGenres)])].slice(0, 6), chapters, timeline, provenanceStatus: chapters ? "verified" : (provenance?.provenanceStatus ?? "incomplete"), linkageDiagnostics, selectedGenreProfiles: selectedGenreNames, warnings: [chapterWarning, renderedIntroduction.warning, selectedGenres.length ? "" : "No reviewed genre profile matched this project; generic instrumental wording was used."].filter(Boolean), channelId: BEYOND_BLACKWALL_CHANNEL_ID, inputSnapshot };
  }

  async diagnoseProjectMixAssociation({ projectId, mixId, sourceFilename }) {
    const project = this.projects.get(projectId); const mix = this.mixStore.get(mixId); const source = await this.uploadService.describeSource(sourceFilename); const provenance = this.compilationVideoService?.getExportProvenance(sourceFilename);
    if (provenance?.outputFingerprint && provenance.outputFingerprint !== source.fingerprint) throw new MetadataConflictError("The compilation MP4 fingerprint conflicts with its saved provenance. Diagnostics were stopped.");
    if (provenance?.mixId && provenance.mixId !== mixId) throw new MetadataConflictError("The selected compilation MP4 was rendered from a different audio mix. Diagnostics were stopped.");
    let verifiedTimeline; if (provenance?.mixId && provenance.mixExportSnapshot && Array.isArray(provenance.timeline)) { const mixExport = (mix.exports ?? []).find((item) => item.snapshot === provenance.mixExportSnapshot && item.filename === provenance.masterFilename); if (!mixExport?.timeline || JSON.stringify(mixExport.timeline) !== JSON.stringify(provenance.timeline)) throw new MetadataConflictError("The compilation provenance conflicts with the retained WAV mix export timeline. Diagnostics were stopped."); verifiedTimeline = validateCompletedTimeline(provenance.timeline, source.duration, provenance.duration); }
    const recordingIds = verifiedTimeline?.map((item) => item.trackId) ?? mix.trackIds;
    const diagnostics = diagnoseProjectMixLinks({ project, mix, recordingIds, projects: this.projects, library: this.library });
    return { ...diagnostics, sourceFilename, sourceFingerprint: source.fingerprint, provenanceStatus: verifiedTimeline ? "verified" : "incomplete" };
  }

  async planProjectMixRepair({ projectId, mixId, sourceFilename }) {
    const diagnostics = await this.diagnoseProjectMixAssociation({ projectId, mixId, sourceFilename }); const project = this.projects.get(projectId);
    if (diagnostics.status === "conflict") throw new MetadataConflictError(`${diagnostics.message} ${formatMissingRecordings(diagnostics.missingRecordings)}`);
    const repairs = diagnostics.missingRecordings.filter((item) => item.repairable).map((item) => ({ plannedTrackId: item.plannedTrackId, libraryTrackId: item.id, title: item.title }));
    if (!repairs.length) throw new MetadataValidationError("No missing link has reliable project and planned-track evidence. Nothing can be safely repaired automatically.");
    const plan = { projectId, mixId, sourceFilename, repairs, project, sourceFingerprint: diagnostics.sourceFingerprint, message: "Only recordings whose stored project ID and planned-track ID match this project can be repaired. Names and durations were not used as ownership evidence." };
    return { ...plan, snapshot: crypto.createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
  }

  async approveProjectMixRepair(input) {
    const plan = await this.planProjectMixRepair(input); if (plan.snapshot !== input.snapshot) throw new MetadataConflictError("The project, mix, MP4 or repair evidence changed. Review the repair again.");
    for (const repair of plan.repairs) { const recording = this.library.get(repair.libraryTrackId); if (recording.projectId !== plan.projectId || recording.plannedTrackId !== repair.plannedTrackId) throw new MetadataConflictError("A recording's project evidence changed. No links were repaired."); }
    await this.projects.repairLegacyLinks(plan.projectId, plan.repairs, plan.project); return { repaired: plan.repairs };
  }

  async generateIndividual({ projectId, trackId }) {
    const profile = this.store.get().profile; if (!profile) throw new MetadataValidationError("Import or create a channel style profile first."); const { project, track } = this.projects.getTrack(projectId, trackId);
    if (!track.libraryTrackId) throw new MetadataValidationError("This planned track does not have a generated recording."); const source = this.library.get(track.libraryTrackId); const selectedGenres = selectGenreProfiles(project, profile.genreProfiles, track); const genre = genreLabel(selectedGenres); const scene = groundedScene(project, track);
    const variables = { project: project.name, track: track.title, genre, mood_or_scene: scene }; const title = renderTemplate(profile.individualTrackTitleTemplate || "{track} // {genre}", variables, TRACK_TEMPLATE_VARIABLES, "Individual-track title template"); if (title.length > 100) throw new MetadataValidationError(`Generated title is ${title.length} characters; YouTube allows 100. Shorten the track title or individual-track template.`);
    const renderedIntroduction = profile.introduction ? renderOptionalTemplate(profile.introduction, variables, DESCRIPTION_TEMPLATE_VARIABLES, "Introduction template") : { text: scene ? `Music for ${scene}.` : "", warning: "" }; const introduction = renderedIntroduction.text; const uses = relevantUses(project, track); const hashtags = [...new Set([...(profile.hashtags ?? []), ...profileHashtags(selectedGenres)])].slice(0, 6); const sections = [introduction, track.direction, uses.length ? `Suitable for ${naturalList(uses)}.` : "", profile.reusableText, profile.links.join("\n"), profile.footer, hashtags.join(" ")].map((value) => String(value ?? "").trim()).filter(Boolean); const description = sections.join("\n\n"); if (description.length > 5000) throw new MetadataValidationError("Generated description exceeds YouTube's 5,000-character limit. Shorten the saved profile text."); const tags = [...new Set([...(profile.tags ?? []), ...(profile.genreVocabulary ?? []), ...profileKeywords(selectedGenres)])]; while (tags.join(",").length > 500) tags.pop(); const inputSnapshot = metadataSnapshot({ project, track, source, profile });
    return { kind: "individual", projectId, trackId, source, title, description, tags, hashtags, chapters: "", timeline: [], selectedGenreProfiles: selectedGenres.map((item) => item.genre), warnings: [renderedIntroduction.warning, selectedGenres.length ? "" : "No reviewed genre profile matched this track; generic instrumental wording was used."].filter(Boolean), channelId: BEYOND_BLACKWALL_CHANNEL_ID, inputSnapshot };
  }

  async approve(input) {
    const generated = input.kind === "individual" ? await this.generateIndividual(input) : await this.generate(input); if (generated.inputSnapshot !== input.inputSnapshot) throw new MetadataConflictError("The source, project, mix, timeline, or style profile changed. Generate and review metadata again.");
    const metadata = validateMetadataEdits(input); const approval = { id: crypto.randomUUID(), kind: generated.kind, projectId: generated.projectId, trackId: generated.trackId, mixId: generated.mixId, sourceFilename: generated.source.filename, sourceFingerprint: generated.source.fingerprint, sourceTrackId: generated.source.id, inputSnapshot: generated.inputSnapshot, title: metadata.title, description: metadata.description, tags: metadata.tags, approvedAt: this.now().toISOString() };
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

export function diagnoseProjectMixLinks({ project, mix, recordingIds = mix?.trackIds ?? [], projects, library }) {
  const linked = new Set(project.tracks.filter((track) => track.libraryTrackId).map((track) => track.libraryTrackId));
  const allProjects = typeof projects?.list === "function" ? projects.list() : [project]; const missingRecordings = [];
  for (const id of recordingIds.filter((recordingId) => !linked.has(recordingId))) {
    let recording; try { recording = library?.get(id); } catch { recording = undefined; }
    const otherLinks = allProjects.filter((candidate) => candidate.id !== project.id && candidate.tracks?.some((track) => track.libraryTrackId === id));
    const plannedTrack = recording?.projectId === project.id && recording?.plannedTrackId ? project.tracks.find((track) => track.id === recording.plannedTrackId) : undefined;
    const confirmedConflict = Boolean(otherLinks.length || (recording?.projectId && recording.projectId !== project.id) || (plannedTrack?.libraryTrackId && plannedTrack.libraryTrackId !== id));
    const repairable = Boolean(!confirmedConflict && plannedTrack && !plannedTrack.libraryTrackId);
    const reason = confirmedConflict ? `Recording evidence points to ${otherLinks[0]?.name ?? recording?.projectId ?? "another project"}.` : repairable ? "Stored recording metadata identifies this project and planned track, but the project link is absent." : "No reliable project-and-planned-track evidence is available; ownership remains unverified.";
    missingRecordings.push({ id, title: recording?.title, status: confirmedConflict ? "confirmed-conflict" : "absent-legacy-link", reason, repairable, plannedTrackId: repairable ? plannedTrack.id : undefined });
  }
  const conflicts = missingRecordings.filter((item) => item.status === "confirmed-conflict");
  return { status: conflicts.length ? "conflict" : missingRecordings.length ? "unverified" : "verified", projectId: project.id, mixId: mix.id, missingRecordings, message: conflicts.length ? "The selected mix contains recordings with confirmed evidence for another project." : missingRecordings.length ? "Some legacy mix recordings are not linked to the selected project." : "Every mix recording is linked to the selected project." };
}

function formatMissingRecordings(items) { return items.map((item) => `${item.id}${item.title ? ` (“${item.title}”)` : ""}: ${item.reason}`).join(" "); }

function normalizeVideo(item) { const snippet = item.snippet ?? {}; return { id: item.id, title: snippet.title ?? "", description: snippet.description ?? "", tags: Array.isArray(snippet.tags) ? snippet.tags : [], thumbnailUrl: snippet.thumbnails?.maxres?.url ?? snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url, publishedAt: snippet.publishedAt, duration: parseIsoDuration(item.contentDetails?.duration) }; }
function publicImportedVideo(video) { return { id: video.id, title: video.title, thumbnailUrl: video.thumbnailUrl, publishedAt: video.publishedAt, duration: video.duration }; }
function emptyData() { return { version: 1, channelId: BEYOND_BLACKWALL_CHANNEL_ID, imports: [], profile: undefined, approvals: [] }; }
function validateProfile(value) { const text = (key, max = 5000) => { const result = String(value?.[key] ?? "").trim(); if (result.length > max) throw new MetadataValidationError(`${key} is too long.`); return result; }; const list = (key) => [...new Set((Array.isArray(value?.[key]) ? value[key] : String(value?.[key] ?? "").split(/[,\n]/)).map((item) => String(item).trim()).filter(Boolean))]; const titleTemplate = validateTemplate(text("titleTemplate", 200), COMPILATION_TEMPLATE_VARIABLES, "Legacy title template"); const compilationTitleTemplate = validateTemplate(text("compilationTitleTemplate", 200), COMPILATION_TEMPLATE_VARIABLES, "Compilation title template"); const individualTrackTitleTemplate = validateTemplate(text("individualTrackTitleTemplate", 200), TRACK_TEMPLATE_VARIABLES, "Individual-track title template"); const introduction = validateTemplate(text("introduction"), DESCRIPTION_TEMPLATE_VARIABLES, "Introduction template"); return { titleTemplate, compilationTitleTemplate, individualTrackTitleTemplate, introduction, footer: text("footer"), reusableText: text("reusableText"), thumbnailBranding: text("thumbnailBranding", 500), links: list("links"), genreVocabulary: list("genreVocabulary"), durationTerminology: list("durationTerminology"), tags: list("tags"), hashtags: list("hashtags"), genreProfiles: Array.isArray(value?.genreProfiles) ? structuredClone(value.genreProfiles) : [] }; }
function mergeProfile(inferred, existing) { return existing ? { ...inferred, ...validateProfile(existing), informedByVideoIds: inferred.informedByVideoIds, findings: inferred.findings, userEdited: true } : inferred; }
function validateMetadataEdits(value) { const title = String(value.title ?? "").trim(); const description = String(value.description ?? "").trim(); const tags = (Array.isArray(value.tags) ? value.tags : String(value.tags ?? "").split(",")).map((tag) => String(tag).trim()).filter(Boolean); if (!title || title.length > 100) throw new MetadataValidationError("YouTube title must contain 1–100 characters."); if (description.length > 5000) throw new MetadataValidationError("YouTube description exceeds 5,000 characters."); if (tags.join(",").length > 500) throw new MetadataValidationError("YouTube tags exceed 500 characters."); return { title, description, tags }; }
function metadataSnapshot(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function naturalList(values) { return values.length < 2 ? values[0] ?? "" : `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`; }
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
