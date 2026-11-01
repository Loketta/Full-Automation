import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rename as fsRename, rm as fsRm, writeFile } from "node:fs/promises";
import { DeletionTransactionError, TrackLibrary, LibraryValidationError } from "../src/library.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-library-"));
  const output = path.join(root, "output");
  t.after(() => fsRm(root, { recursive: true, force: true }));
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

test("review status remains synchronized with persisted metadata when a write fails", async (t) => {
  const { output, dependencies } = await fixture(t);
  let fail = false;
  const library = new TrackLibrary(output, {
    ...dependencies,
    rename: async (source, destination) => {
      if (fail && path.basename(destination) === "library.json") throw new Error("mock review persistence failure");
      return fsRename(source, destination);
    },
  });
  await library.initialize();
  await writeFile(path.join(output, "review-sync.mp3"), "audio");
  const track = await library.registerGenerated({ filename: "review-sync.mp3", prompt: "Review synchronization prompt" });
  fail = true;
  await assert.rejects(() => library.update(track.id, { reviewStatus: "Reject" }), /mock review persistence failure/);
  assert.equal(library.get(track.id).reviewStatus, "Unreviewed");

  const restarted = new TrackLibrary(output, dependencies);
  await restarted.initialize();
  assert.equal(restarted.get(track.id).reviewStatus, "Unreviewed");
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

test("metadata-write failure rolls the MP3 back and retains its record", async (t) => {
  const { output, dependencies } = await fixture(t);
  let failMetadataRename = false;
  const library = new TrackLibrary(output, {
    ...dependencies,
    rename: async (source, destination) => {
      if (failMetadataRename && path.basename(destination) === "library.json") {
        throw Object.assign(new Error("simulated metadata failure"), { code: "EIO" });
      }
      return fsRename(source, destination);
    },
  });
  await library.initialize();
  const audioPath = path.join(output, "protected.mp3");
  await writeFile(audioPath, "protected audio");
  const track = await library.registerGenerated({ filename: "protected.mp3", prompt: "Protected prompt" });

  failMetadataRename = true;
  await assert.rejects(() => library.delete(track.id), (error) => {
    assert.ok(error instanceof DeletionTransactionError);
    assert.equal(error.recoveryPending, false);
    assert.match(error.message, /MP3 was restored/);
    return true;
  });

  assert.equal(await readFile(audioPath, "utf8"), "protected audio");
  assert.equal(library.list().length, 1);
  const metadata = JSON.parse(await readFile(path.join(output, "library.json"), "utf8"));
  assert.equal(metadata.tracks[0].id, track.id);
  assert.equal((await readdir(output)).some((name) => name.startsWith(".deleting-")), false);
});

test("filesystem move failure leaves MP3 and metadata untouched", async (t) => {
  const { output, dependencies } = await fixture(t);
  let failAudioMove = false;
  const library = new TrackLibrary(output, {
    ...dependencies,
    rename: async (source, destination) => {
      if (failAudioMove && path.basename(source) === "move-protected.mp3") {
        throw Object.assign(new Error("simulated move failure"), { code: "EACCES" });
      }
      return fsRename(source, destination);
    },
  });
  await library.initialize();
  const audioPath = path.join(output, "move-protected.mp3");
  await writeFile(audioPath, "must remain");
  const track = await library.registerGenerated({ filename: "move-protected.mp3", prompt: "Prompt" });

  failAudioMove = true;
  await assert.rejects(() => library.delete(track.id), /simulated move failure/);
  assert.equal(await readFile(audioPath, "utf8"), "must remain");
  assert.equal(library.list().length, 1);
  const metadata = JSON.parse(await readFile(path.join(output, "library.json"), "utf8"));
  assert.equal(metadata.tracks.length, 1);
});

test("failed rollback is recovered on restart without losing the MP3", async (t) => {
  const { output, dependencies } = await fixture(t);
  let failTransaction = false;
  const library = new TrackLibrary(output, {
    ...dependencies,
    rename: async (source, destination) => {
      if (failTransaction && path.basename(destination) === "library.json") {
        throw new Error("simulated metadata failure");
      }
      if (failTransaction && path.basename(source).startsWith(".deleting-")) {
        throw new Error("simulated rollback failure");
      }
      return fsRename(source, destination);
    },
  });
  await library.initialize();
  const audioPath = path.join(output, "recover-me.mp3");
  await writeFile(audioPath, "recoverable audio");
  const track = await library.registerGenerated({ filename: "recover-me.mp3", prompt: "Prompt" });

  failTransaction = true;
  await assert.rejects(() => library.delete(track.id), (error) => {
    assert.ok(error instanceof DeletionTransactionError);
    assert.equal(error.recoveryPending, true);
    return true;
  });
  await assert.rejects(() => readFile(audioPath), { code: "ENOENT" });
  assert.equal((await readdir(output)).some((name) => name.startsWith(".deleting-")), true);

  const restarted = new TrackLibrary(output, dependencies);
  const tracks = await restarted.initialize();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].id, track.id);
  assert.equal(await readFile(audioPath, "utf8"), "recoverable audio");
  assert.equal((await readdir(output)).some((name) => name.startsWith(".deleting-")), false);
});

test("cleanup failure is reported and completed on restart", async (t) => {
  const { output, dependencies } = await fixture(t);
  let failCleanup = false;
  const library = new TrackLibrary(output, {
    ...dependencies,
    rm: async (target, options) => {
      if (failCleanup && path.basename(target).startsWith(".deleting-")) {
        throw new Error("simulated cleanup failure");
      }
      return fsRm(target, options);
    },
  });
  await library.initialize();
  const deletePath = path.join(output, "delete-with-cleanup.mp3");
  const keepPath = path.join(output, "keep-safe.mp3");
  await writeFile(deletePath, "delete audio");
  await writeFile(keepPath, "keep audio");
  const deletedTrack = await library.registerGenerated({ filename: "delete-with-cleanup.mp3", prompt: "Delete" });
  const keptTrack = await library.registerGenerated({ filename: "keep-safe.mp3", prompt: "Keep" });

  failCleanup = true;
  const result = await library.delete(deletedTrack.id);
  assert.equal(result.cleanupPending, true);
  assert.match(result.warning, /next starts/);
  assert.deepEqual(library.list().map((track) => track.id), [keptTrack.id]);
  assert.equal(await readFile(keepPath, "utf8"), "keep audio");
  assert.equal((await readdir(output)).some((name) => name.startsWith(".deleting-")), true);

  const restarted = new TrackLibrary(output, dependencies);
  const tracks = await restarted.initialize();
  assert.deepEqual(tracks.map((track) => track.id), [keptTrack.id]);
  assert.equal(await readFile(keepPath, "utf8"), "keep audio");
  assert.equal((await readdir(output)).some((name) => name.startsWith(".deleting-")), false);
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
