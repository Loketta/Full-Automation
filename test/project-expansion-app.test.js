import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { ProjectStore } from "../src/projects.js";

const basePlan = { version: 1, name: "Neon", theme: "Instrumental synthwave.", tracks: [{ identifier: "one", title: "One", direction: "Opening.", prompt: "Instrumental synthwave opening with no vocals.", energy: "high", position: 1 }] };
const expansion = { version: 1, name: "Expansion", theme: "Different metadata that remains informational.", tracks: [{ identifier: "two", title: "Two", direction: "Follow-up direction.", prompt: "Instrumental synthwave follow-up with no vocals.", energy: "moderate", position: 2 }] };

test("file expansion API previews and atomically appends without calling generation", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-project-expansion-app-")); t.after(() => rm(root, { recursive: true, force: true })); const output = path.join(root, "output"); const projects = new ProjectStore(output); await projects.initialize(); const project = await projects.import(basePlan); let paidCalls = 0;
  const app = createApp({ client: { interactions: { create() { paidCalls += 1; } } }, library: { list: () => [] }, projects, outputDirectory: output, publicDirectory: path.join(root, "public") }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const previewResponse = await fetch(`${base}/api/projects/${project.id}/append-file/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "expansion.json", plan: expansion }) }); assert.equal(previewResponse.status, 200); const { preview } = await previewResponse.json(); assert.equal(preview.destination.name, "Neon"); assert.equal(preview.resultingTrackCount, 2);
  const stale = await fetch(`${base}/api/projects/${project.id}/append-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "expansion.json", plan: expansion, snapshot: "stale" }) }); assert.equal(stale.status, 409); assert.equal(projects.get(project.id).tracks.length, 1);
  const appended = await fetch(`${base}/api/projects/${project.id}/append-file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "expansion.json", plan: expansion, snapshot: preview.snapshot }) }); assert.equal(appended.status, 201); assert.equal((await appended.json()).project.tracks.length, 2); assert.equal(paidCalls, 0);
});
