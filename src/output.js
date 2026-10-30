import crypto from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

export function createOutputFilename(now = new Date(), randomUUID = crypto.randomUUID) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const id = randomUUID().replace(/[^a-f0-9-]/gi, "").slice(0, 8);
  return `lyria-${timestamp}-${id}.mp3`;
}

export async function saveMp3(base64Audio, outputDirectory, dependencies = {}) {
  if (typeof base64Audio !== "string" || base64Audio.length === 0) {
    throw new Error("Lyria returned no audio data.");
  }

  const audio = Buffer.from(base64Audio, "base64");
  if (audio.length === 0) {
    throw new Error("Lyria returned empty audio data.");
  }

  const mkdirFn = dependencies.mkdir ?? mkdir;
  const writeFileFn = dependencies.writeFile ?? writeFile;
  const filename = createOutputFilename(dependencies.now, dependencies.randomUUID);
  await mkdirFn(outputDirectory, { recursive: true });
  await writeFileFn(path.join(outputDirectory, filename), audio, { flag: "wx" });
  return filename;
}
