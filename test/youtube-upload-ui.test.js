import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("upload UI is private-only, confirms before start, and exposes saved-session resume", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /YouTube Uploads/); assert.match(html, /Private only/); assert.doesNotMatch(html, /value="(?:public|unlisted)"/i);
  assert.match(app, /buildYouTubeUploadConfirmation\(plan\)/); assert.match(app, /window\.confirm/); assert.match(app, /\/api\/youtube\/uploads/);
  const startFunction = app.slice(app.indexOf("async function startYouTubeUpload"), app.indexOf("async function resumeYouTubeUpload"));
  assert.ok(startFunction.indexOf("window.confirm(buildYouTubeUploadConfirmation(plan))") < startFunction.indexOf('apiJson("/api/youtube/uploads"'));
  assert.match(app, /Resume saved session/); assert.match(app, /No new YouTube video or upload session will be created/);
  assert.match(app, /Altered\/synthetic content: YES/); assert.match(app, /Confirm Studio disclosure review/); assert.match(app, /studio\.youtube\.com\/video/);
  assert.doesNotMatch(app, /sessionUrl|accessToken|refreshToken/);
});
