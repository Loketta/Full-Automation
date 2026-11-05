import test from "node:test";
import assert from "node:assert/strict";
import { buildMetadataCopy, classifyGenres, COMPILATION_TEMPLATE_VARIABLES, DESCRIPTION_TEMPLATE_VARIABLES, genreLabel, groundedScene, profileKeywords, renderOptionalTemplate, renderTemplate, selectGenreProfiles, TRACK_TEMPLATE_VARIABLES, validateTemplate } from "../src/youtube-metadata-engine.js";

const profiles = ["industrial", "synthwave", "lo-fi", "metal", "jazz", "space"].map((genre) => ({ genre, keywords: [genre, genre === "space" ? "space opera" : `${genre} sound`], tags: [`${genre} music`], hashtags: [`#${genre.replace("-", "")}`] }));

test("ranks reviewed genres deterministically and supports mixed and unknown projects", () => {
  for (const profile of profiles) assert.equal(selectGenreProfiles({ name: "Project", theme: `Instrumental ${profile.genre} music`, tracks: [] }, profiles)[0].genre, profile.genre);
  const classification = classifyGenres({ name: "Mixed", theme: "Industrial synthwave and metal music", tracks: [] }, profiles); assert.equal(classification.primary.length, 2); assert.deepEqual([...classification.primary, ...classification.influences].map((item) => item.genre).sort(), ["industrial", "metal", "synthwave"]); assert.doesNotMatch(genreLabel(classification.primary), /\//);
  assert.deepEqual(selectGenreProfiles({ name: "Unknown", theme: "Acoustic pastoral sound", tracks: [] }, profiles), []); assert.equal(genreLabel([]), "Instrumental");
});

test("genre ranking ignores negation and does not promote one unrelated track", () => {
  const project = { name: "Afterhours", theme: "Dark industrial cyberpunk collection with synthwave atmosphere. No metal; avoid EDM and not orchestral.", tracks: [
    { id: "a", title: "Foundry", direction: "Mechanical industrial rhythm", prompt: "Industrial electronics, 110 BPM, D minor, no metal." },
    { id: "b", title: "Neon", direction: "Dark synthwave atmosphere", prompt: "Synthwave electronics. Avoid metal." },
    { id: "c", title: "Edge", direction: "Industrial tension", prompt: "One distorted metal guitar accent, otherwise industrial." },
  ] };
  const ranked = classifyGenres(project, profiles); assert.deepEqual(ranked.primary.map((item) => item.genre), ["industrial", "synthwave"]); assert.equal([...ranked.primary, ...ranked.influences].some((item) => item.genre === "metal"), false);
  const hybrid = classifyGenres({ name: "Forge", theme: "A genuine industrial metal hybrid combining industrial electronics and metal guitar.", tracks: [] }, profiles); assert.deepEqual(new Set(hybrid.primary.map((item) => item.genre)), new Set(["industrial", "metal"]));
});

test("listener copy removes production instructions and remains stable and natural", () => {
  const project = { id: "afterhours", name: "Industrial Afterhours", theme: "A cohesive instrumental cyberpunk collection exploring an industrial city after midnight. Dark synthwave, mechanical techno, atmospheric tension and restrained melodic hooks; no vocals.", tracks: [{ id: "a", title: "Foundry", direction: "Industrial rhythm", prompt: "110 BPM, D minor, sidechain the bass, model output instrumental only, no vocals, avoid metal." }] };
  const classification = classifyGenres(project, profiles); const first = buildMetadataCopy({ project, classification, durationLabel: "1 Hour" }); const second = buildMetadataCopy({ project, classification, durationLabel: "1 Hour" }); assert.deepEqual(first, second); assert.equal(first.genre, "Dark Industrial & Cyberpunk Synthwave"); assert.match(first.introduction, /after midnight|city keeps moving/i); assert.match(first.identity, /hour-long instrumental/i); assert.doesNotMatch(`${first.introduction} ${first.identity}`, /110 BPM|D minor|sidechain|model output|no vocals|\.\./i); assert.deepEqual(profileKeywords(classification.primary).includes("metal"), false); assert.doesNotMatch(profileKeywords(classification.primary).join(" "), /combat/i);
  const sparse = buildMetadataCopy({ project: { id: "sparse", name: "Untitled", theme: "Instrumental collection.", tracks: [] }, classification: classifyGenres({ name: "Untitled", theme: "Instrumental collection.", tracks: [] }, profiles) }); assert.equal(sparse.genre, "Instrumental"); assert.ok(sparse.omittedFields.length);
});

test("templates reject unsupported or unresolved variables without truncation", () => {
  assert.throws(() => validateTemplate("{project} {invented}", COMPILATION_TEMPLATE_VARIABLES, "Compilation title template"), /unsupported.*\{invented\}/i);
  assert.equal(renderTemplate("{project} || {genre} Mix ({duration})", { project: "Afterhours", genre: "Industrial", duration: "1 Hour" }, COMPILATION_TEMPLATE_VARIABLES, "Compilation"), "Afterhours || Industrial Mix (1 Hour)");
  assert.throws(() => renderTemplate("{track} // {mood_or_scene}", { track: "Signal", mood_or_scene: "" }, TRACK_TEMPLATE_VARIABLES, "Track"), /does not provide grounded information/);
  assert.equal(groundedScene({ theme: "Instrumental dark industrial music." }), "");
});

test("individual genre selection excludes unrelated mixed-project tracks", () => {
  const project = { name: "Mixed Collection", theme: "Cyberpunk collection.", tracks: [{ title: "Foundry", direction: "Industrial combat music for tabletop gaming", prompt: "Heavy industrial combat track with mechanical percussion." }, { title: "Neon Coast", direction: "Dreamy synthwave for late-night driving", prompt: "Retro synthwave pads and arpeggios." }] };
  assert.deepEqual(selectGenreProfiles(project, profiles, project.tracks[0]).map((item) => item.genre), ["industrial"]);
  assert.deepEqual(selectGenreProfiles(project, profiles, project.tracks[1]).map((item) => item.genre), ["synthwave"]);
  const industrial = buildMetadataCopy({ project, track: project.tracks[0], classification: classifyGenres(project, profiles, project.tracks[0]) }); const synthwave = buildMetadataCopy({ project, track: project.tracks[1], classification: classifyGenres(project, profiles, project.tracks[1]) }); assert.notEqual(industrial.identity, synthwave.identity); assert.match(industrial.identity, /Foundry.*industrial/i); assert.match(synthwave.identity, /Neon Coast.*synthwave/i);
});

test("scene language is conservative for realistic technical generation text", () => {
  const technicalTrack = { direction: "Instrumental industrial cyberpunk music with distorted bass, mechanical percussion, 110 BPM, minor key and no vocals.", prompt: "Create a long evolving arrangement with sidechained synth bass, gated drums, metallic impacts, layered arpeggios and a mastered wide stereo mix. No vocals." };
  assert.equal(groundedScene({ theme: "Industrial cyberpunk production." }, technicalTrack), "");
  assert.deepEqual(renderOptionalTemplate("Music for {mood_or_scene}.", { mood_or_scene: "" }, DESCRIPTION_TEMPLATE_VARIABLES, "Introduction template"), { text: "", warning: "Introduction template was omitted because {mood_or_scene} could not be grounded in the saved metadata." });
  assert.equal(groundedScene({ theme: "Cyberpunk music." }, { direction: "Music for late-night drives through rain-soaked streets. Slow build, no vocals." }), "late-night drives through rain-soaked streets");
});
