import crypto from "node:crypto";

export const DEFAULT_STYLE_MODEL = "gemini-3.1-flash-lite";
export const STYLE_ANALYSIS_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    report: {
      type: "object", additionalProperties: false,
      properties: {
        summary: { type: "string" },
        observedConventions: { type: "array", items: { type: "object", additionalProperties: false, properties: { category: { type: "string" }, pattern: { type: "string" }, sourceVideoIds: { type: "array", items: { type: "string" } }, examples: { type: "array", items: { type: "string" } } }, required: ["category", "pattern", "sourceVideoIds", "examples"] } },
        inconsistencies: { type: "array", items: { type: "object", additionalProperties: false, properties: { issue: { type: "string" }, sourceVideoIds: { type: "array", items: { type: "string" } } }, required: ["issue", "sourceVideoIds"] } },
        recommendations: { type: "array", items: { type: "object", additionalProperties: false, properties: { recommendation: { type: "string" }, rationale: { type: "string" }, sourceVideoIds: { type: "array", items: { type: "string" } } }, required: ["recommendation", "rationale", "sourceVideoIds"] } },
      }, required: ["summary", "observedConventions", "inconsistencies", "recommendations"],
    },
    proposedProfile: {
      type: "object", additionalProperties: false,
      properties: {
        compilationTitleTemplate: { type: "string" }, individualTrackTitleTemplate: { type: "string" },
        universalBranding: { type: "object", additionalProperties: false, properties: { introduction: { type: "string" }, footer: { type: "string" }, callsToAction: { type: "array", items: { type: "string" } }, recurringLinks: { type: "array", items: { type: "string" } } }, required: ["introduction", "footer", "callsToAction", "recurringLinks"] },
        universalTags: { type: "array", items: { type: "string" } }, universalHashtags: { type: "array", items: { type: "string" } },
        genreProfiles: { type: "array", items: { type: "object", additionalProperties: false, properties: { genre: { type: "string" }, keywords: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } }, hashtags: { type: "array", items: { type: "string" } }, sourceVideoIds: { type: "array", items: { type: "string" } } }, required: ["genre", "keywords", "tags", "hashtags", "sourceVideoIds"] } },
      }, required: ["compilationTitleTemplate", "individualTrackTitleTemplate", "universalBranding", "universalTags", "universalHashtags", "genreProfiles"],
    },
  }, required: ["report", "proposedProfile"],
};

export class YouTubeStyleAiService {
  constructor({ client, store, model = DEFAULT_STYLE_MODEL, maxInputTokens = 100000, maxOutputTokens = 6000, inputUsdPerMillion, outputUsdPerMillion, now = () => Date.now(), randomUUID = crypto.randomUUID }) {
    Object.assign(this, { client, store, model, inputUsdPerMillion, outputUsdPerMillion, now, randomUUID }); this.maxInputTokens = positiveInteger(maxInputTokens, 100000); this.maxOutputTokens = positiveInteger(maxOutputTokens, 6000); this.pending = new Map(); this.active = false;
  }
  plan() {
    const videos = this.store.get().imports ?? []; if (videos.length < 5) throw new StyleAiValidationError("At least five imported channel videos are required before AI analysis.");
    const input = buildAnalysisInput(videos); const estimatedInputTokens = estimateTokens(input); const oversized = estimatedInputTokens > this.maxInputTokens;
    const id = this.randomUUID(); const snapshot = crypto.createHash("sha256").update(JSON.stringify({ id, model: this.model, input, maxInputTokens: this.maxInputTokens })).digest("hex");
    this.pending.set(snapshot, { input, videoIds: videos.map((video) => video.id), expiresAt: this.now() + 10 * 60_000 }); this.#expire();
    return { snapshot, model: this.model, videoCount: videos.length, estimatedInputTokens, maximumInputTokens: this.maxInputTokens, maximumBillableRequests: 1, estimatedMaximumCostUsd: this.#cost(estimatedInputTokens), oversized, message: oversized ? "The imported dataset exceeds the configured one-request input limit. Increase the limit deliberately or use a separately approved analysis strategy; no request was made." : "One Gemini text request will be made only after explicit confirmation. No automatic retry is performed." };
  }
  async analyse(snapshot) {
    if (this.active) throw new StyleAiConflictError("Another channel-style analysis is already active."); this.#expire(); const approved = this.pending.get(snapshot); if (!approved) throw new StyleAiConflictError("The AI analysis approval is missing, expired, or already used. Review a new plan.");
    this.pending.delete(snapshot); const estimated = estimateTokens(approved.input); if (estimated > this.maxInputTokens) throw new StyleAiValidationError("The imported dataset exceeds the configured maximum input tokens. No model request was made.");
    this.active = true;
    try {
      let interaction;
      try { interaction = await this.client.interactions.create({ model: this.model, input: analysisPrompt(approved.input), response_format: { type: "text", mime_type: "application/json", schema: STYLE_ANALYSIS_SCHEMA } }); }
      catch (error) { throw new StyleAiProviderError("Gemini channel-style analysis failed. No automatic retry was made; review the server diagnostic before approving another request.", { cause: error }); }
      const result = validateAiAnalysis(parseOutput(interaction), new Set(approved.videoIds)); const proposal = { id: this.randomUUID(), model: this.model, videoCount: approved.videoIds.length, sourceVideoIds: approved.videoIds, createdAt: new Date(this.now()).toISOString(), ...result };
      await this.store.update((data) => { data.aiProposal = proposal; }); return proposal;
    } finally { this.active = false; }
  }
  #cost(inputTokens) { const input = Number(this.inputUsdPerMillion); const output = Number(this.outputUsdPerMillion); return Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0 ? Number(((inputTokens * input + this.maxOutputTokens * output) / 1_000_000).toFixed(6)) : undefined; }
  #expire() { const now = this.now(); for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key); }
}

export function buildAnalysisInput(videos) { return JSON.stringify({ channelId: "UCXO7g--zW3kReNXhcZNu_vg", videos: videos.map((video) => ({ id: video.id, title: video.title, description: video.description, tags: video.tags, durationSeconds: video.duration, publishedAt: video.publishedAt })) }); }
export function estimateTokens(text) { return Math.ceil(String(text).length / 4); }
export function validateAiAnalysis(value, importedIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new StyleAiResponseError("Gemini returned malformed channel-style JSON.");
  const { report, proposedProfile } = value; if (!report || !proposedProfile || typeof report.summary !== "string" || !report.summary.trim()) throw new StyleAiResponseError("Gemini returned an incomplete channel-style report.");
  for (const key of ["observedConventions", "inconsistencies", "recommendations"]) if (!Array.isArray(report[key])) throw new StyleAiResponseError(`Gemini response is missing report.${key}.`);
  if (report.observedConventions.some((item) => !item || typeof item.category !== "string" || typeof item.pattern !== "string" || !Array.isArray(item.sourceVideoIds) || !Array.isArray(item.examples))) throw new StyleAiResponseError("Gemini returned malformed observed conventions.");
  if (report.inconsistencies.some((item) => !item || typeof item.issue !== "string" || !Array.isArray(item.sourceVideoIds)) || report.recommendations.some((item) => !item || typeof item.recommendation !== "string" || typeof item.rationale !== "string" || !Array.isArray(item.sourceVideoIds))) throw new StyleAiResponseError("Gemini returned malformed analysis findings.");
  const references = [...report.observedConventions, ...report.inconsistencies, ...report.recommendations, ...(proposedProfile.genreProfiles ?? [])].flatMap((item) => item.sourceVideoIds ?? []);
  if (references.some((id) => !importedIds.has(id))) throw new StyleAiResponseError("Gemini cited a video that was not included in the approved imported dataset.");
  if (!proposedProfile.compilationTitleTemplate?.trim() || !proposedProfile.individualTrackTitleTemplate?.trim() || !proposedProfile.universalBranding || !Array.isArray(proposedProfile.universalTags) || !Array.isArray(proposedProfile.universalHashtags) || !Array.isArray(proposedProfile.genreProfiles)) throw new StyleAiResponseError("Gemini returned an incomplete proposed channel profile.");
  if (typeof proposedProfile.universalBranding.introduction !== "string" || typeof proposedProfile.universalBranding.footer !== "string" || !Array.isArray(proposedProfile.universalBranding.callsToAction) || !Array.isArray(proposedProfile.universalBranding.recurringLinks) || proposedProfile.genreProfiles.some((item) => !item || typeof item.genre !== "string" || !Array.isArray(item.keywords) || !Array.isArray(item.tags) || !Array.isArray(item.hashtags) || !Array.isArray(item.sourceVideoIds))) throw new StyleAiResponseError("Gemini returned malformed proposed profile fields.");
  if (!report.observedConventions.length || report.observedConventions.some((item) => item.sourceVideoIds.length < 2 || item.examples.length < 1)) throw new StyleAiResponseError("Every observed convention must include an example and at least two imported source video IDs.");
  return structuredClone(value);
}

function analysisPrompt(input) { return `Analyse this public YouTube channel metadata deterministically and conservatively. Distinguish observed conventions from recommendations. Every observed claim must cite supplied video IDs. Do not invent facts or copy one-off video-specific text into universal branding. Separate compilation and individual-track formats, and separate universal branding from genre-specific metadata. Return only schema-conforming JSON.\n\n${input}`; }
function parseOutput(interaction) { const text = interaction?.output_text ?? interaction?.steps?.findLast?.((step) => step.type === "model_output")?.content?.find?.((item) => item.type === "text")?.text; if (typeof text !== "string") throw new StyleAiResponseError("Gemini returned no structured text output."); try { return JSON.parse(text); } catch { throw new StyleAiResponseError("Gemini returned invalid JSON."); } }
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }

export class StyleAiValidationError extends Error { constructor(message) { super(message); this.statusCode = 400; } }
export class StyleAiConflictError extends Error { constructor(message) { super(message); this.statusCode = 409; } }
export class StyleAiResponseError extends Error { constructor(message) { super(message); this.statusCode = 502; } }
export class StyleAiProviderError extends Error { constructor(message, options) { super(message, options); this.statusCode = 502; } }
