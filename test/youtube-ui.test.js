import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("YouTube UI shows verified identity, uses Google authorization, and confirms disconnect", async () => {
  const [html, app] = await Promise.all([readFile("public/index.html", "utf8"), readFile("public/app.js", "utf8")]);
  assert.match(html, /YouTube Connection/); assert.match(html, /future visibility defaults to Private/);
  assert.match(app, /Channel ID:/); assert.match(app, /connection\.channel\.handle/); assert.match(app, /thumbnailUrl/);
  assert.match(app, /window\.open\(data\.authorizationUrl/); assert.match(app, /Reconnect or change channel/);
  assert.match(app, /window\.confirm\("Disconnect the verified YouTube channel\?/);
  assert.match(app, /\/api\/youtube\/disconnect/);
  assert.doesNotMatch(app, /access_token|refresh_token|client_secret/);
});
