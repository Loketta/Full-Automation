import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { saveMp3 } from "../src/output.js";

test("writes decoded audio to a safe unique MP3 filename", async () => {
  const calls = [];
  const filename = await saveMp3(Buffer.from("fake mp3").toString("base64"), "C:\\safe-output", {
    now: new Date("2026-10-30T12:34:56.789Z"),
    randomUUID: () => "abcdef12-3456-7890-abcd-ef1234567890",
    mkdir: async (...args) => calls.push(["mkdir", ...args]),
    writeFile: async (...args) => calls.push(["writeFile", ...args]),
  });

  assert.equal(filename, "lyria-2026-10-30T12-34-56-789Z-abcdef12.mp3");
  assert.equal(calls[0][0], "mkdir");
  assert.equal(calls[1][0], "writeFile");
  assert.equal(path.basename(calls[1][1]), filename);
  assert.deepEqual(calls[1][3], { flag: "wx" });
  assert.equal(calls[1][2].toString(), "fake mp3");
});

test("rejects missing audio before touching disk", async () => {
  await assert.rejects(() => saveMp3("", "ignored"), /no audio data/);
});
