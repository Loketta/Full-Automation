import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { EncryptedCredentialStore, YOUTUBE_DEFAULT_VISIBILITY, YOUTUBE_SCOPES, YouTubeConnectionService } from "../src/youtube.js";

function channel(id = "UC-one", name = "Industrial Channel") {
  return { id, snippet: { title: name, customUrl: `@${name.replaceAll(" ", "")}`, thumbnails: { high: { url: `https://example.test/${id}.jpg` } } } };
}

function fixture(overrides = {}) {
  const saved = [];
  const store = overrides.store ?? {
    value: overrides.connection,
    async load() { return this.value; },
    async save(value) { this.value = structuredClone(value); saved.push(structuredClone(value)); },
    async clear() { this.value = undefined; },
  };
  const oauthClients = [];
  const authOptions = [];
  const oauthFactory = overrides.oauthFactory ?? (() => {
    const client = {
      credentials: undefined, revoked: undefined,
      generateAuthUrl(options) { authOptions.push(options); return `https://accounts.google.test/auth?state=${options.state}`; },
      async getToken() { return { tokens: { access_token: "temporary-access", refresh_token: overrides.refreshToken ?? "refresh-secret" } }; },
      setCredentials(credentials) { this.credentials = credentials; },
      async revokeToken(token) { this.revoked = token; },
      on() {},
    };
    oauthClients.push(client); return client;
  });
  let currentItems = overrides.items ?? [channel()];
  const youtubeFactory = overrides.youtubeFactory ?? (() => ({ channels: { list: async (request) => {
    if (overrides.youtubeError) throw overrides.youtubeError;
    assert.deepEqual(request.part, ["snippet"]); assert.equal(request.mine, true);
    return { data: { items: currentItems } };
  } } }));
  const service = new YouTubeConnectionService({ outputDirectory: "unused", clientId: "client-id", clientSecret: "client-secret", redirectUri: "http://127.0.0.1:3000/api/youtube/oauth/callback" }, {
    store, oauthFactory, youtubeFactory, now: () => 1_700_000_000_000,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  return { service, store, saved, oauthClients, authOptions, setItems(items) { currentItems = items; } };
}

test("authorization requests only readonly/upload scopes and binds the authorized channel", async () => {
  const values = fixture(); await values.service.initialize();
  const url = values.service.beginAuthorization();
  assert.match(url, /^https:\/\/accounts\.google\.test/);
  const options = values.authOptions[0];
  assert.deepEqual(options.scope, YOUTUBE_SCOPES); assert.equal(options.access_type, "offline"); assert.equal(options.prompt, "consent select_account");
  assert.equal(YOUTUBE_SCOPES.includes("https://www.googleapis.com/auth/youtube.force-ssl"), false);
  const status = await values.service.completeAuthorization({ state: options.state, code: "authorization-code" });
  assert.equal(status.connected, true); assert.equal(status.channel.id, "UC-one"); assert.equal(status.channel.handle, "@IndustrialChannel");
  assert.equal(status.defaultVisibility, "private"); assert.equal(status.uploadsEnabled, false);
  assert.deepEqual(values.oauthClients[1].credentials, { access_token: "temporary-access", refresh_token: "refresh-secret" });
  assert.equal(values.store.value.refreshToken, "refresh-secret"); assert.equal(values.store.value.defaultVisibility, YOUTUBE_DEFAULT_VISIBILITY);
});

test("rejects invalid state, missing refresh tokens, and ambiguous channel identities", async () => {
  const values = fixture(); await values.service.initialize(); values.service.beginAuthorization();
  await assert.rejects(() => values.service.completeAuthorization({ state: "wrong", code: "code" }), /invalid or expired/);

  const missing = fixture({ refreshToken: undefined, oauthFactory: () => ({
    generateAuthUrl: () => "url", async getToken() { return { tokens: { access_token: "temporary" } }; }, setCredentials() {}, on() {},
  }) });
  await missing.service.initialize(); missing.service.beginAuthorization();
  const missingState = [...missing.service.pendingStates.keys()][0];
  await assert.rejects(() => missing.service.completeAuthorization({ state: missingState, code: "code" }), /did not issue a refresh token/);

  const ambiguous = fixture({ items: [channel("one"), channel("two")] }); await ambiguous.service.initialize(); ambiguous.service.beginAuthorization();
  const ambiguousState = ambiguous.authOptions[0].state;
  await assert.rejects(() => ambiguous.service.completeAuthorization({ state: ambiguousState, code: "code" }), /multiple channel identities/);
});

test("reconnection replaces the binding only with the newly authorized Google channel", async () => {
  const values = fixture(); await values.service.initialize();
  values.service.beginAuthorization(); await values.service.completeAuthorization({ state: values.authOptions[0].state, code: "one" });
  values.setItems([channel("UC-two", "Second Channel")]);
  values.service.beginAuthorization(); const status = await values.service.completeAuthorization({ state: values.authOptions[1].state, code: "two" });
  assert.equal(status.channel.id, "UC-two"); assert.equal(values.store.value.channel.id, "UC-two");
  assert.equal(values.authOptions[1].prompt, "consent select_account");
});

test("refresh verification preserves identity and revoked credentials require reconnection", async () => {
  const connection = { version: 1, refreshToken: "stored-refresh", channel: { id: "UC-one", name: "Old" }, scopes: YOUTUBE_SCOPES, defaultVisibility: "private" };
  const valid = fixture({ connection }); await valid.service.initialize();
  const verified = await valid.service.verify(); assert.equal(verified.connected, true); assert.equal(verified.channel.name, "Industrial Channel");
  assert.deepEqual(valid.oauthClients[0].credentials, { refresh_token: "stored-refresh" });

  const revoked = fixture({ connection, youtubeError: Object.assign(new Error("invalid_grant"), { code: 401 }) }); await revoked.service.initialize();
  const status = await revoked.service.verify(); assert.equal(status.connected, false); assert.equal(status.reconnectRequired, true); assert.match(status.message, /revoked/);
});

test("disconnect revokes server-side refresh authorization and removes local state", async () => {
  const connection = { version: 1, refreshToken: "stored-refresh", channel: { id: "UC-one", name: "Channel" }, scopes: YOUTUBE_SCOPES, defaultVisibility: "private" };
  const values = fixture({ connection }); await values.service.initialize();
  const status = await values.service.disconnect();
  assert.equal(values.oauthClients[0].revoked, "stored-refresh"); assert.equal(values.store.value, undefined); assert.equal(status.connected, false);
});

test("missing configuration fails clearly and never starts authorization", async () => {
  const service = new YouTubeConnectionService({ outputDirectory: "unused", clientId: "", clientSecret: "", redirectUri: "" });
  const status = await service.initialize(); assert.equal(status.configured, false); assert.equal(status.connected, false);
  assert.throws(() => service.beginAuthorization(), /not configured/);
});

test("credential store encrypts refresh tokens and restores them without plaintext leakage", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-youtube-store-")); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EncryptedCredentialStore(root, "local-client-secret");
  const value = { version: 1, refreshToken: "highly-sensitive-refresh-token", channel: { id: "UC-safe", name: "Safe" } };
  await store.save(value);
  const onDisk = await readFile(path.join(root, "youtube-credentials.enc"), "utf8");
  assert.doesNotMatch(onDisk, /highly-sensitive|UC-safe|Safe/);
  assert.deepEqual(await store.load(), value);
  await store.clear(); assert.equal(await store.load(), undefined);
});
