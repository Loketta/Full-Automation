import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("metadata UI keeps import and generation separate from the explicitly confirmed private upload", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /Import Channel Style/); assert.match(html, /Refresh Channel Style/); assert.match(html, /Chapter preview/); assert.match(html, /Use in Private Upload/);
  assert.match(app, /\/api\/youtube\/metadata\/import/); assert.match(app, /\/api\/youtube\/metadata\/generate/); assert.match(app, /\/api\/youtube\/metadata\/approve/);
  assert.match(app, /Copied to the Private Upload form/); assert.match(app, /approvedYouTubeUploadPlan = undefined/);
  assert.match(html, /Export metadata for review/); assert.match(html, /Import reviewed analysis/); assert.match(html, /Accept proposed profile changes/);
  assert.match(html, /Compilation variables/); assert.match(html, /Individual-track variables/); assert.match(html, /Metadata type/); assert.match(html, /Generated project track/);
  assert.match(app, /generate-track/); assert.match(app, /Primary genres/); assert.match(app, /Secondary influences/); assert.match(app, /Omitted:/);
  assert.match(app, /youtubeMetadataUse\.disabled = individual/);
  assert.match(html, /Recover legacy chapter provenance/); assert.match(html, /Review WAV recovery/); assert.match(html, /Review selected MP4 association/); assert.match(app, /No verified chapters are available; no timestamps were guessed/); assert.match(app, /Provenance:/);
  assert.match(app, /beyond-the-blackwall\.json/); assert.match(app, /analysis-import/); assert.match(app, /existing profile fields are unchanged/); assert.doesNotMatch(app, /Gemini|billable requests|metadata\/ai/);
  assert.match(html, /Review evidence-backed legacy link repair/); assert.match(app, /link-repair\/plan/); assert.match(app, /link-repair\/approve/); assert.match(app, /No recordings or media files will be modified/);
  const generate = app.slice(app.indexOf("async function generateYouTubeMetadata"), app.indexOf("async function approveYouTubeMetadata")); assert.doesNotMatch(generate, /\/api\/youtube\/uploads/);
  assert.match(generate, /catch \(error\).*youtubeMetadataStatus\.textContent = error\.message/s);
});
