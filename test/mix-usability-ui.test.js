import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("mix UI uses direct recording actions, accepted-project action, and duration preview", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /id="mix-track-select"/);
  assert.doesNotMatch(html, /id="mix-add-track"/);
  assert.match(html, /id="mix-recording-list"/);
  assert.match(html, /id="mix-add-accepted"/);
  assert.match(html, /id="mix-duration-preview"[^>]*aria-live="polite"/);
  assert.match(app, /addSingleRecordingToMix/);
  assert.match(app, /addAllAcceptedToMix/);
  assert.match(app, /requestId !== mixPreviewRequest/);
});

test("short preview disables rendering while authorized rendering still uses plan snapshot and confirmation", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /if \(!preview\.meetsMinimum\)/);
  assert.match(app, /blocked\.disabled = true/);
  assert.match(app, /\/plan`, \{ method: "POST" \}/);
  assert.match(app, /window\.confirm\(buildMixConfirmation\(plan\)\)/);
  assert.match(app, /snapshot: plan\.snapshot/);
});
