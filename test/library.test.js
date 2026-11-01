import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { TrackLibrary, LibraryValidationError } from "../src/library.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-library-"));
  const output = path.join(root, "output");
  t.after(() => rm(root, { recursive: true, force: true }));
  let id = 0;
  const dependencies = {
    randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => new Date("2026-11-01T12:00:00.000Z"),
  };
  return { root, output, dependencies };
}

test("imports existing MP3s once without modifying their audio", async (t) => {
  const { output, dependencies } = await fixture(t);
  await mkdir(output, { recursive: true });
  const audioPath = path.join(output, "existing-track.mp3");
  const originalAudio = Buffer.from("existing audio bytes");
  await writeFile(audioPath, originalAudio);

  const library = new TrackLibrary(output, dependencies);
  const firstScan = await library.initialize();
  const secondScan = await library.initialize();

  assert.equal(firstScan.length, 1);
  assert.equal(secondScan.length, 1);
  assert.equal(secondScan[0].filename, "existing-track.mp3");
  assert.equal(secondScan[0].title, "existing track");
  assert.match(secondScan[0].prompt, /unavailable/i);
  assert.equal(secondScan[0].reviewStatus, "Unreviewed");
  assert.deepEqual(await readFile(audioPath), originalAudio);
});

test("persists generated metadata, renames, and review status across restart", async (t) => {
  const { output, dependencies } = await fixture(t);
  const library = new TrackLibrary(output, dependencies);
  await library.initialize();
  await writeFile(path.join(output, "generated.mp3"), "audio");
  const created = await library.registerGenerated({
    filename: "generated.mp3",
    prompt: "Dark cyberpunk instrumental, no vocals",
  });
  await library.update(created.id, { title: "Neon Rain", reviewStatus: "Keep" });

  const restarted = new TrackLibrary(output, dependencies);
  const tracks = await restarted.initialize();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, created.id);
  assert.equal(tracks[0].title, "Neon Rain");
  assert.equal(tracks[0].reviewStatus, "Keep");
  assert.equal(tracks[0].prompt, "Dark cyberpunk instrumental, no vocals");
});

test("metadata file remains valid JSON after successive writes", async (t) => {
  const { output, dependencies } = await fixture(t);
  const library = new TrackLibrary(output, dependencies);
  await library.initialize();
  await writeFile(path.join(output, "track.mp3"), "audio");
  const track = await library.registerGenerated({ filename: "track.mp3", prompt: "Ambient instrumental" });
  await library.update(track.id, { title: "Ambient One" });
  await library.update(track.id, { reviewStatus: "Reject" });

  const metadata = JSON.parse(await readFile(path.join(output, "library.json"), "utf8"));
  assert.equal(metadata.version, 1);
  assert.equal(metadata.tracks[0].title, "Ambient One");
  assert.equal(metadata.tracks[0].reviewStatus, "Reject");
});

test("deletion removes both MP3 and metadata", async (t) => {
  const { output, dependencies } = await fixture(t);
  const library = new TrackLibrary(output, dependencies);
  await library.initialize();
  const audioPath = path.join(output, "delete-me.mp3");
  await writeFile(audioPath, "audio");
  const track = await library.registerGenerated({ filename: "delete-me.mp3", prompt: "Test instrumental" });

  await library.delete(track.id);
  await assert.rejects(() => readFile(audioPath), { code: "ENOENT" });
  assert.equal(library.list().length, 0);
  const restarted = new TrackLibrary(output, dependencies);
  assert.equal((await restarted.initialize()).length, 0);
});

test("directory traversal cannot delete a file outside output", async (t) => {
  const { root, output, dependencies } = await fixture(t);
  await mkdir(output, { recursive: true });
  const outsidePath = path.join(root, "outside.mp3");
  await writeFile(outsidePath, "must survive");
  await writeFile(path.join(output, "library.json"), JSON.stringify({
    version: 1,
    tracks: [{
      id: "malicious",
      filename: "../outside.mp3",
      title: "Outside",
      prompt: "Unknown",
      createdAt: "2026-11-01T00:00:00.000Z",
      reviewStatus: "Unreviewed",
    }],
  }));

  const library = new TrackLibrary(output, dependencies);
  await library.initialize();
  await assert.rejects(() => library.delete("malicious"), LibraryValidationError);
  assert.equal(await readFile(outsidePath, "utf8"), "must survive");
});

test("rejects invalid titles and review statuses", async (t) => {
  const { output, dependencies } = await fixture(t);
  const library = new TrackLibrary(output, dependencies);
  await library.initialize();
  await writeFile(path.join(output, "track.mp3"), "audio");
  const track = await library.registerGenerated({ filename: "track.mp3", prompt: "Prompt" });

  await assert.rejects(() => library.update(track.id, { title: " " }), LibraryValidationError);
  await assert.rejects(() => library.update(track.id, { reviewStatus: "Maybe" }), LibraryValidationError);
});
