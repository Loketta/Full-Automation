import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("metadata UI keeps import and generation separate from the explicitly confirmed private upload", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /Import Channel Style/); assert.match(html, /Refresh Channel Style/); assert.match(html, /Chapter preview/); assert.match(html, /Use in Private Upload/);
  assert.match(app, /\/api\/youtube\/metadata\/import/); assert.match(app, /\/api\/youtube\/metadata\/generate/); assert.match(app, /\/api\/youtube\/metadata\/approve/);
  assert.match(app, /Copied to the Private Upload form/); assert.match(app, /approvedYouTubeUploadPlan = undefined/);
  assert.match(html, /Export metadata for review/); assert.match(html, /Import reviewed analysis/); assert.match(html, /Accept proposed profile changes/);
  assert.match(app, /beyond-the-blackwall\.json/); assert.match(app, /analysis-import/); assert.match(app, /existing profile fields are unchanged/); assert.doesNotMatch(app, /Gemini|billable requests|metadata\/ai/);
  const generate = app.slice(app.indexOf("async function generateYouTubeMetadata"), app.indexOf("async function approveYouTubeMetadata")); assert.doesNotMatch(generate, /\/api\/youtube\/uploads/);
});
