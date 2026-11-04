import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("metadata UI keeps import and generation separate from the explicitly confirmed private upload", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /Import Channel Style/); assert.match(html, /Refresh Channel Style/); assert.match(html, /Chapter preview/); assert.match(html, /Use in Private Upload/);
  assert.match(app, /\/api\/youtube\/metadata\/import/); assert.match(app, /\/api\/youtube\/metadata\/generate/); assert.match(app, /\/api\/youtube\/metadata\/approve/);
  assert.match(app, /Copied to the Private Upload form/); assert.match(app, /approvedYouTubeUploadPlan = undefined/);
  assert.match(html, /Analyse Channel with AI/); assert.match(html, /Accept proposed profile changes/);
  const ai = app.slice(app.indexOf("async function analyseYouTubeStyleWithAi"), app.indexOf("async function acceptYouTubeStyleProposal")); assert.ok(ai.indexOf("window.confirm") < ai.indexOf("/api/youtube/metadata/ai/analyse")); assert.match(ai, /Maximum billable requests/); assert.match(ai, /No automatic retry/);
  const generate = app.slice(app.indexOf("async function generateYouTubeMetadata"), app.indexOf("async function approveYouTubeMetadata")); assert.doesNotMatch(generate, /\/api\/youtube\/uploads/);
});
