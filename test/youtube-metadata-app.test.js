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
    async generateIndividual(body) { calls.push(["generate-track", body]); return { title: "Track metadata" }; },
    async planProjectMixRepair(body) { calls.push(["link-repair-plan", body]); return { snapshot: "repair" }; },
    async diagnoseProjectMixAssociation(body) { calls.push(["link-diagnostics", body]); return { status: "unverified" }; },
    async approveProjectMixRepair(body) { calls.push(["link-repair-approve", body]); return { repaired: [] }; },
    async approve(body) { calls.push(["approve", body]); return { id: "approved" }; },
    exportChannelAnalysis() { calls.push("analysis-export"); return { version: 1, videos: [] }; },
    async importChannelAnalysis(body) { calls.push(["analysis-import", body]); return { id: "proposal" }; },
    async acceptChannelAnalysis(id) { calls.push(["analysis-accept", id]); return { compilationTitleTemplate: "Template" }; },
  };
  const app = createApp({ client: { interactions: { async create() { assert.fail("Lyria must not be called"); } } }, library: { list: () => [] }, projects: { list: () => [] }, youtubeMetadataService, outputDirectory: root, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/youtube/metadata`)).json()).approvals.length, 0);
  const hostile = await fetch(`${base}/api/youtube/metadata/import`, { method: "POST", headers: { Origin: "https://hostile.example" } }); assert.equal(hostile.status, 403); assert.equal(calls.length, 0);
  const imported = await fetch(`${base}/api/youtube/metadata/import`, { method: "POST" }); assert.equal(imported.status, 200); assert.deepEqual(calls, ["import"]);
  await fetch(`${base}/api/youtube/metadata/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "p" }) }); assert.equal(calls.at(-1)[0], "generate");
  await fetch(`${base}/api/youtube/metadata/generate-track`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "p", trackId: "t" }) }); assert.equal(calls.at(-1)[0], "generate-track");
  await fetch(`${base}/api/youtube/metadata/link-repair/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "p" }) }); assert.equal(calls.at(-1)[0], "link-repair-plan");
  await fetch(`${base}/api/youtube/metadata/link-diagnostics`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "p" }) }); assert.equal(calls.at(-1)[0], "link-diagnostics");
  await fetch(`${base}/api/youtube/metadata/link-repair/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshot: "repair" }) }); assert.equal(calls.at(-1)[0], "link-repair-approve");
  await fetch(`${base}/api/youtube/metadata/analysis-export`); assert.equal(calls.at(-1), "analysis-export");
  await fetch(`${base}/api/youtube/metadata/analysis-import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1 }) }); assert.deepEqual(calls.at(-1), ["analysis-import", { version: 1 }]);
  await fetch(`${base}/api/youtube/metadata/analysis-accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposalId: "proposal" }) }); assert.deepEqual(calls.at(-1), ["analysis-accept", "proposal"]);
  assert.equal(calls.some((call) => call === "upload"), false);
});
