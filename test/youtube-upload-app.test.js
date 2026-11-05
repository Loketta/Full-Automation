import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../src/app.js";

test("upload API keeps destination/private policy server-side and rejects cross-origin starts", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-upload-app-")); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const plan = { source: { filename: "complete.mp4", size: 100, duration: 3640, fingerprint: "hash" }, title: "Complete", description: "Description", tags: ["music"], visibility: "private", channel: { id: "UC-bound", name: "Bound" }, snapshot: "snapshot" };
  const youtubeUploadService = {
    async listSources() { return [{ filename: "complete.mp4", size: 100 }]; }, list() { return []; }, status() { return { active: false }; },
    async plan(body) { calls.push(["plan", body]); return plan; }, async start(body) { calls.push(["start", body]); return { id: "upload", visibility: "private", channelId: "UC-bound" }; }, async resume(id) { calls.push(["resume", id]); return { id, status: "Uploading" }; }, async confirmDisclosure(id) { calls.push(["disclosure", id]); return { id, disclosureStatus: "ManuallyConfirmed" }; },
  };
  const app = createApp({ client: {}, library: { list: () => [] }, projects: { list: () => [] }, youtubeUploadService, outputDirectory: root, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const listing = await (await fetch(`${base}/api/youtube/uploads`)).json(); assert.equal(listing.sources[0].filename, "complete.mp4");
  const hostile = await fetch(`${base}/api/youtube/uploads`, { method: "POST", headers: { Origin: "https://hostile.example", "Content-Type": "application/json" }, body: JSON.stringify({ visibility: "public", channelId: "attacker" }) }); assert.equal(hostile.status, 403); assert.equal(calls.length, 0);
  const planned = await (await fetch(`${base}/api/youtube/uploads/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "complete.mp4", title: "Complete", visibility: "public", channelId: "attacker" }) })).json();
  assert.equal(planned.plan.visibility, "private"); assert.equal(planned.plan.channel.id, "UC-bound");
  const started = await (await fetch(`${base}/api/youtube/uploads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "complete.mp4", title: "Complete", snapshot: "snapshot", visibility: "public", channelId: "attacker" }) })).json();
  assert.equal(started.upload.visibility, "private"); assert.equal(started.upload.channelId, "UC-bound");
  await fetch(`${base}/api/youtube/uploads/upload/resume`, { method: "POST" }); assert.deepEqual(calls.at(-1), ["resume", "upload"]);
  const disclosure = await (await fetch(`${base}/api/youtube/uploads/upload/disclosure-confirmation`, { method: "POST" })).json(); assert.equal(disclosure.upload.disclosureStatus, "ManuallyConfirmed"); assert.deepEqual(calls.at(-1), ["disclosure", "upload"]);
});
