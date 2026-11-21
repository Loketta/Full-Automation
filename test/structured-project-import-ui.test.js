import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("project-plan UI previews before explicit creation and exposes safe export", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /Review project plan/); assert.match(html, /project-import-preview/); assert.match(html, /Export project plan/);
  const importFlow = app.slice(app.indexOf('importProjectForm.addEventListener'), app.indexOf('projectSelect.addEventListener'));
  assert.ok(importFlow.indexOf('/import/preview') < importFlow.indexOf('Create imported project')); assert.ok(importFlow.indexOf('window.confirm') < importFlow.lastIndexOf('apiJson(endpoint'));
  assert.match(importFlow, /JSON\.parse/); assert.match(importFlow, /Invalid JSON/);
  assert.match(app, /Planned duration is not evidence/); assert.match(app, /not a verified property of the generated recording/); assert.match(app, /Credentials, audio, upload records and machine-specific state were excluded/);
});
