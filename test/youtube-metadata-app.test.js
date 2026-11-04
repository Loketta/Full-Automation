import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../src/app.js";

test("metadata API is local-only and never invokes upload or generation clients", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-metadata-app-")); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = []; const youtubeMetadataService = {
    state() { return { profile: undefined, importedVideos: [], approvals: [] }; },
    async importChannel() { calls.push("import"); return this.state(); },
    async saveProfile(body) { calls.push(["profile", body]); return body; },
    async generate(body) { calls.push(["generate", body]); return { title: "Private metadata" }; },
    async approve(body) { calls.push(["approve", body]); return { id: "approved" }; },
  };
  const app = createApp({ client: { interactions: { async create() { assert.fail("Lyria must not be called"); } } }, library: { list: () => [] }, projects: { list: () => [] }, youtubeMetadataService, outputDirectory: root, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/youtube/metadata`)).json()).approvals.length, 0);
  const hostile = await fetch(`${base}/api/youtube/metadata/import`, { method: "POST", headers: { Origin: "https://hostile.example" } }); assert.equal(hostile.status, 403); assert.equal(calls.length, 0);
  const imported = await fetch(`${base}/api/youtube/metadata/import`, { method: "POST" }); assert.equal(imported.status, 200); assert.deepEqual(calls, ["import"]);
  await fetch(`${base}/api/youtube/metadata/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "p" }) }); assert.equal(calls.at(-1)[0], "generate");
  assert.equal(calls.some((call) => call === "upload"), false);
});
