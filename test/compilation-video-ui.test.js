import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("compilation UI provides a dedicated plan-first workflow with explicit confirmation", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /id="compilation-video-heading">Compilation Video Assembly/);
  assert.match(html, /id="compilation-master"/); assert.match(html, /id="compilation-asset"/); assert.match(html, /id="compilation-title"/);
  assert.match(app, /\/api\/compilation-videos\/plan/); assert.match(app, /buildCompilationVideoConfirmation\(plan\)/);
  assert.match(app, /window\.confirm/); assert.match(app, /\/api\/compilation-videos\/render/);
  assert.ok(app.indexOf("window.confirm(buildCompilationVideoConfirmation(plan))") < app.indexOf('apiJson("/api/compilation-videos/render"'));
});
