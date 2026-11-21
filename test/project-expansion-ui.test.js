import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("project import UI exposes reviewed append and compilation-selection clarity", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /Append tracks to an existing project/); assert.match(html, /Destination project/); assert.match(html, /Accepted recordings are available but are not included automatically/); assert.match(html, /ordered list above is the compilation selection/);
  const flow = app.slice(app.indexOf('importProjectForm.addEventListener'), app.indexOf('projectSelect.addEventListener')); assert.match(flow, /append-file\/preview/); assert.match(flow, /Append reviewed tracks/); assert.match(flow, /Existing tracks, recordings, statuses, order and project metadata remain unchanged/); assert.ok(flow.indexOf("window.confirm") < flow.lastIndexOf("/append-file"));
});
