import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Track Overview has an accessible sticky batch footer and eligible checkbox wiring", async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<footer class="track-overview-batch-footer" aria-label="Track Overview batch controls">/);
  assert.match(html, /id="overview-batch-count"[^>]*>0 \/ 5 selected/);
  assert.match(html, /id="overview-generate-batch"/);
  assert.match(html, /id="overview-clear-batch"/);
  assert.match(css, /\.track-overview-scroll[^}]*overflow-y: auto/);
  assert.match(css, /\.track-overview-batch-footer/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(app, /checkbox\.setAttribute\("aria-label", `Select \$\{track\.title\} for batch generation`\)/);
});

test("both Generate Batch buttons invoke the existing confirmed batch workflow", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /generateBatchButton\.addEventListener\("click", startBatch\)/);
  assert.match(app, /overviewGenerateBatchButton\.addEventListener\("click", startBatch\)/);
  assert.match(app, /window\.confirm\(buildBatchConfirmation\(project\.name, expected\.tracks\)\)/);
  assert.equal((app.match(/\/batches`, \{/g) ?? []).length, 1);
});
