import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { ProjectStore } from "../src/projects.js";

const plan = { version: 1, name: "Structured", theme: "Instrumental melodic electronic compilation.", thematicOpening: "Music for the open road.", targetDurationMinutes: 62, tracks: [{ identifier: "opening", title: "Opening", direction: "Energetic opening.", prompt: "Instrumental melodic electronic opening with no vocals.", energy: "high", position: 1 }] };

test("HTTP import is preview-first, snapshot-bound, duplicate-safe, and makes no generation call", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-structured-import-app-")); t.after(() => rm(root, { recursive: true, force: true })); const projects = new ProjectStore(path.join(root, "output")); await projects.initialize(); let paidCalls = 0;
  const app = createApp({ client: { interactions: { create() { paidCalls += 1; } } }, library: { list: () => [] }, projects, outputDirectory: path.join(root, "output"), publicDirectory: path.join(root, "public") }); const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const previewResponse = await fetch(`${base}/api/projects/import/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "structured.json", plan }) }); assert.equal(previewResponse.status, 200); const { preview } = await previewResponse.json(); assert.equal(projects.list().length, 0);
  const stale = await fetch(`${base}/api/projects/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "structured.json", plan, snapshot: "stale" }) }); assert.equal(stale.status, 409); assert.equal(projects.list().length, 0);
  const imported = await fetch(`${base}/api/projects/import`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "structured.json", plan, snapshot: preview.snapshot }) }); assert.equal(imported.status, 201); const created = (await imported.json()).project; assert.equal(paidCalls, 0);
  const exported = await (await fetch(`${base}/api/projects/${created.id}/export-plan`)).json(); assert.equal(exported.name, "Structured"); assert.equal(exported.tracks[0].energy, "high");
  const duplicate = await fetch(`${base}/api/projects/import/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "again.json", plan }) }); assert.equal(duplicate.status, 409);
});
