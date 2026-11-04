import test from "node:test";
import assert from "node:assert/strict";
import { COMPILATION_TEMPLATE_VARIABLES, genreLabel, groundedScene, renderTemplate, selectGenreProfiles, TRACK_TEMPLATE_VARIABLES, validateTemplate } from "../src/youtube-metadata-engine.js";

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
  assert.equal(groundedScene({ theme: "Instrumental dark industrial music." }), "dark industrial");
});
