import test from "node:test";
import assert from "node:assert/strict";
import { COMPILATION_TEMPLATE_VARIABLES, DESCRIPTION_TEMPLATE_VARIABLES, genreLabel, groundedScene, renderOptionalTemplate, renderTemplate, selectGenreProfiles, TRACK_TEMPLATE_VARIABLES, validateTemplate } from "../src/youtube-metadata-engine.js";

const profiles = ["industrial", "synthwave", "lo-fi", "metal", "jazz", "space"].map((genre) => ({ genre, keywords: [genre, genre === "space" ? "space opera" : `${genre} sound`], tags: [`${genre} music`], hashtags: [`#${genre.replace("-", "")}`] }));

test("selects every reviewed genre deterministically and supports mixed and unknown projects", () => {
  for (const profile of profiles) assert.equal(selectGenreProfiles({ name: "Project", theme: `Instrumental ${profile.genre} music`, tracks: [] }, profiles)[0].genre, profile.genre);
  const mixed = selectGenreProfiles({ name: "Mixed", theme: "Industrial synthwave and metal music", tracks: [] }, profiles); assert.deepEqual(mixed.map((item) => item.genre), ["industrial", "synthwave", "metal"]); assert.equal(genreLabel(mixed), "industrial / synthwave / metal");
  assert.deepEqual(selectGenreProfiles({ name: "Unknown", theme: "Acoustic pastoral sound", tracks: [] }, profiles), []); assert.equal(genreLabel([]), "Instrumental");
});

test("templates reject unsupported or unresolved variables without truncation", () => {
  assert.throws(() => validateTemplate("{project} {invented}", COMPILATION_TEMPLATE_VARIABLES, "Compilation title template"), /unsupported.*\{invented\}/i);
  assert.equal(renderTemplate("{project} || {genre} Mix ({duration})", { project: "Afterhours", genre: "industrial", duration: "1 Hour" }, COMPILATION_TEMPLATE_VARIABLES, "Compilation"), "Afterhours || industrial Mix (1 Hour)");
  assert.throws(() => renderTemplate("{track} // {mood_or_scene}", { track: "Signal", mood_or_scene: "" }, TRACK_TEMPLATE_VARIABLES, "Track"), /does not provide grounded information/);
  assert.equal(groundedScene({ theme: "Instrumental dark industrial music." }), "");
});

test("individual genre selection excludes unrelated mixed-project tracks", () => {
  const project = { name: "Mixed Collection", theme: "Cyberpunk collection.", tracks: [{ title: "Foundry", direction: "Industrial combat music for tabletop gaming", prompt: "Heavy industrial combat track with mechanical percussion." }, { title: "Neon Coast", direction: "Dreamy synthwave for late-night driving", prompt: "Retro synthwave pads and arpeggios." }] };
  assert.deepEqual(selectGenreProfiles(project, profiles, project.tracks[0]).map((item) => item.genre), ["industrial"]);
  assert.deepEqual(selectGenreProfiles(project, profiles, project.tracks[1]).map((item) => item.genre), ["synthwave"]);
});

test("scene language is conservative for realistic technical generation text", () => {
  const technicalTrack = { direction: "Instrumental industrial cyberpunk music with distorted bass, mechanical percussion, 110 BPM, minor key and no vocals.", prompt: "Create a long evolving arrangement with sidechained synth bass, gated drums, metallic impacts, layered arpeggios and a mastered wide stereo mix. No vocals." };
  assert.equal(groundedScene({ theme: "Industrial cyberpunk production." }, technicalTrack), "");
  assert.deepEqual(renderOptionalTemplate("Music for {mood_or_scene}.", { mood_or_scene: "" }, DESCRIPTION_TEMPLATE_VARIABLES, "Introduction template"), { text: "", warning: "Introduction template was omitted because {mood_or_scene} could not be grounded in the saved metadata." });
  assert.equal(groundedScene({ theme: "Cyberpunk music." }, { direction: "Music for late-night drives through rain-soaked streets. Slow build, no vocals." }), "late-night drives through rain-soaked streets");
});
