import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp } from "../src/app.js";

test("YouTube connection API exposes channel identity but never OAuth credentials", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-app-")); t.after(() => rm(root, { recursive: true, force: true }));
  let disconnected = false; let completed;
  const publicStatus = { configured: true, connected: true, reconnectRequired: false, channel: { id: "UC-safe", name: "Safe Channel", handle: "@safe", thumbnailUrl: "https://example.test/safe.jpg" }, defaultVisibility: "private", uploadsEnabled: false, message: "Connected." };
  const youtubeService = {
    async verify() { return publicStatus; },
    beginAuthorization() { return "https://accounts.google.test/authorize?state=opaque"; },
    async completeAuthorization(query) { completed = query; return publicStatus; },
    async disconnect() { disconnected = true; return { ...publicStatus, connected: false, channel: undefined }; },
  };
  const app = createApp({ client: {}, library: { list: () => [] }, projects: { list: () => [] }, youtubeService, outputDirectory: root, publicDirectory: path.join(root, "public") });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(`${base}/api/youtube/status`)).json();
  assert.equal(status.connection.channel.id, "UC-safe"); assert.equal(status.connection.defaultVisibility, "private");
  assert.doesNotMatch(JSON.stringify(status), /access_token|refresh_token|client_secret/);
  const connect = await (await fetch(`${base}/api/youtube/connect`, { method: "POST" })).json(); assert.match(connect.authorizationUrl, /^https:\/\/accounts\.google\.test/);
  const crossOrigin = await fetch(`${base}/api/youtube/disconnect`, { method: "POST", headers: { Origin: "https://malicious.example" } }); assert.equal(crossOrigin.status, 403); assert.equal(disconnected, false);
  const callback = await fetch(`${base}/api/youtube/oauth/callback?state=opaque&code=authorization-code`); assert.equal(callback.status, 200); assert.match(await callback.text(), /YouTube connected/); assert.equal(completed.state, "opaque"); assert.equal(completed.code, "authorization-code");
  const disconnectedResponse = await (await fetch(`${base}/api/youtube/disconnect`, { method: "POST" })).json(); assert.equal(disconnected, true); assert.equal(disconnectedResponse.connection.connected, false);
});
