import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { google } from "googleapis";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/youtube.upload",
];
export const YOUTUBE_DEFAULT_VISIBILITY = "private";
const CREDENTIALS_FILENAME = "youtube-credentials.enc";
const STATE_LIFETIME_MS = 10 * 60 * 1000;

export class EncryptedCredentialStore {
  constructor(outputDirectory, secret, dependencies = {}) {
    this.outputDirectory = path.resolve(outputDirectory);
    this.filePath = path.join(this.outputDirectory, CREDENTIALS_FILENAME);
    this.secret = secret;
    this.fs = { mkdir: dependencies.mkdir ?? mkdir, readFile: dependencies.readFile ?? readFile, rename: dependencies.rename ?? rename, rm: dependencies.rm ?? rm, writeFile: dependencies.writeFile ?? writeFile };
    this.randomBytes = dependencies.randomBytes ?? crypto.randomBytes;
  }

  async load() {
    try {
      const envelope = JSON.parse(await this.fs.readFile(this.filePath, "utf8"));
      const salt = Buffer.from(envelope.salt, "base64"); const iv = Buffer.from(envelope.iv, "base64");
      const key = crypto.scryptSync(this.#secret(), salt, 32);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
      const value = JSON.parse(plaintext.toString("utf8"));
      if (value?.version !== 1 || typeof value.refreshToken !== "string" || !value.channel?.id) throw new Error("Unsupported credential data.");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw new YouTubeCredentialError("Stored YouTube authorization could not be decrypted. Reconnect the channel using the configured OAuth client.");
    }
  }

  async save(value) {
    await this.fs.mkdir(this.outputDirectory, { recursive: true });
    const salt = this.randomBytes(16); const iv = this.randomBytes(12); const key = crypto.scryptSync(this.#secret(), salt, 32);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const envelope = `${JSON.stringify({ version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }, null, 2)}\n`;
    const temporaryPath = path.join(this.outputDirectory, `.youtube-credentials-${this.randomBytes(8).toString("hex")}.tmp`);
    try {
      await this.fs.writeFile(temporaryPath, envelope, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await this.fs.rename(temporaryPath, this.filePath);
    } catch (error) { await this.fs.rm(temporaryPath, { force: true }).catch(() => {}); throw error; }
  }

  async clear() { await this.fs.rm(this.filePath, { force: true }); }
  #secret() { if (typeof this.secret !== "string" || this.secret.length < 8) throw new YouTubeConfigurationError("YouTube OAuth client secret is missing or too short."); return this.secret; }
}

export class YouTubeConnectionService {
  constructor({ outputDirectory, clientId, clientSecret, redirectUri }, dependencies = {}) {
    this.clientId = clientId; this.clientSecret = clientSecret; this.redirectUri = redirectUri;
    this.configured = Boolean(clientId && clientSecret && redirectUri);
    this.store = dependencies.store ?? new EncryptedCredentialStore(outputDirectory, clientSecret, dependencies.storeDependencies);
    this.oauthFactory = dependencies.oauthFactory ?? (() => new google.auth.OAuth2(clientId, clientSecret, redirectUri));
    this.youtubeFactory = dependencies.youtubeFactory ?? ((auth) => google.youtube({ version: "v3", auth }));
    this.now = dependencies.now ?? (() => Date.now());
    this.randomBytes = dependencies.randomBytes ?? crypto.randomBytes;
    this.pendingStates = new Map();
    this.connection = undefined;
    this.credentialError = undefined;
  }

  async initialize() {
    if (!this.configured) return this.status();
    try { this.connection = await this.store.load(); }
    catch (error) { this.credentialError = error.message; }
    return this.status();
  }

  status() {
    return {
      configured: this.configured,
      connected: Boolean(this.connection) && !this.credentialError,
      reconnectRequired: Boolean(this.credentialError),
      message: !this.configured ? "YouTube OAuth is not configured. Add the Desktop OAuth client settings and restart."
        : this.credentialError ?? (this.connection ? "Connected to the verified YouTube channel." : "YouTube is not connected."),
      channel: this.connection ? structuredClone(this.connection.channel) : undefined,
      defaultVisibility: YOUTUBE_DEFAULT_VISIBILITY,
      uploadsEnabled: false,
    };
  }

  beginAuthorization() {
    this.#assertConfigured();
    const state = this.randomBytes(32).toString("base64url");
    this.pendingStates.set(state, this.now() + STATE_LIFETIME_MS);
    this.#removeExpiredStates();
    const client = this.oauthFactory();
    return client.generateAuthUrl({
      access_type: "offline", prompt: "consent select_account", include_granted_scopes: true,
      scope: YOUTUBE_SCOPES, state,
    });
  }

  async completeAuthorization({ state, code, error }) {
    this.#assertConfigured();
    const expiresAt = this.pendingStates.get(state); this.pendingStates.delete(state);
    if (!state || !expiresAt || expiresAt < this.now()) throw new YouTubeAuthorizationError("The YouTube authorization session is invalid or expired. Start again from the application.");
    if (error) throw new YouTubeAuthorizationError("Google authorization was cancelled or denied. No channel was connected.");
    if (typeof code !== "string" || !code) throw new YouTubeAuthorizationError("Google did not return an authorization code.");
    const client = this.oauthFactory();
    let tokens;
    try { ({ tokens } = await client.getToken(code)); }
    catch (cause) { throw new YouTubeAuthorizationError("Google could not complete authorization. Start a new connection and try again.", { cause }); }
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new YouTubeAuthorizationError("Google did not issue a refresh token. Revoke the app connection in your Google Account, then reconnect and approve offline access.");
    client.setCredentials(tokens);
    const channel = await this.#fetchAuthorizedChannel(client);
    const connection = { version: 1, refreshToken, channel, scopes: YOUTUBE_SCOPES, defaultVisibility: YOUTUBE_DEFAULT_VISIBILITY, connectedAt: new Date(this.now()).toISOString() };
    await this.store.save(connection);
    this.connection = connection; this.credentialError = undefined;
    return this.status();
  }

  async verify() {
    if (!this.connection) return this.status();
    try {
      const client = this.#authorizedClient();
      const channel = await this.#fetchAuthorizedChannel(client);
      if (channel.id !== this.connection.channel.id) throw new YouTubeAuthorizationError("The authorized YouTube channel identity changed. Reconnect and verify the intended channel before any future upload.");
      this.connection = { ...this.connection, channel };
      await this.store.save(this.connection);
      this.credentialError = undefined;
    } catch (error) {
      this.credentialError = isRevokedError(error)
        ? "YouTube authorization expired or was revoked. Reconnect and verify the channel."
        : error.message;
    }
    return this.status();
  }

  async disconnect() {
    if (this.connection) {
      try { await this.#authorizedClient().revokeToken(this.connection.refreshToken); }
      catch { /* Local removal must still complete when Google already revoked the token or is unreachable. */ }
    }
    await this.store.clear(); this.connection = undefined; this.credentialError = undefined; this.pendingStates.clear();
    return this.status();
  }

  async getVerifiedUploadContext() {
    const status = await this.verify();
    if (!status.connected || !this.connection) throw new YouTubeAuthorizationError(status.message || "Reconnect and verify the YouTube channel before uploading.");
    const client = this.#authorizedClient();
    return {
      channel: structuredClone(this.connection.channel),
      getAccessToken: async () => {
        const result = await client.getAccessToken();
        const token = typeof result === "string" ? result : result?.token;
        if (!token) throw new YouTubeAuthorizationError("YouTube access could not be refreshed. Reconnect before uploading.");
        return token;
      },
    };
  }

  #authorizedClient() {
    const client = this.oauthFactory(); client.setCredentials({ refresh_token: this.connection.refreshToken });
    client.on?.("tokens", (tokens) => {
      if (tokens.refresh_token && this.connection) {
        this.connection = { ...this.connection, refreshToken: tokens.refresh_token };
        this.store.save(this.connection).catch(() => { this.credentialError = "A refreshed YouTube credential could not be persisted. Reconnect before any future upload."; });
      }
    });
    return client;
  }

  async #fetchAuthorizedChannel(client) {
    try {
      const response = await this.youtubeFactory(client).channels.list({ part: ["snippet"], mine: true, maxResults: 50 });
      const items = response?.data?.items ?? [];
      if (items.length !== 1) throw new YouTubeAuthorizationError(items.length
        ? "Google returned multiple channel identities. Reconnect and choose the intended YouTube channel in Google's authorization screen."
        : "No YouTube channel was found for this authorization. Choose a Google identity that owns a YouTube channel.");
      const item = items[0]; const snippet = item.snippet ?? {};
      return { id: item.id, name: snippet.title, handle: snippet.customUrl, thumbnailUrl: chooseThumbnail(snippet.thumbnails) };
    } catch (error) {
      if (error instanceof YouTubeAuthorizationError) throw error;
      throw new YouTubeAuthorizationError("The authorized YouTube channel could not be identified. Reconnect if access was revoked.", { cause: error });
    }
  }

  #assertConfigured() { if (!this.configured) throw new YouTubeConfigurationError("YouTube OAuth is not configured. Set the Desktop OAuth client ID and secret, then restart."); }
  #removeExpiredStates() { for (const [state, expiry] of this.pendingStates) if (expiry < this.now()) this.pendingStates.delete(state); }
}

function chooseThumbnail(thumbnails = {}) { return thumbnails.high?.url ?? thumbnails.medium?.url ?? thumbnails.default?.url; }
function isRevokedError(error) { const value = `${error?.code ?? ""} ${error?.message ?? ""} ${error?.cause?.message ?? ""}`.toLowerCase(); return value.includes("invalid_grant") || value.includes("unauthorized") || value.includes("401"); }

export class YouTubeConfigurationError extends Error { constructor(message) { super(message); this.statusCode = 503; } }
export class YouTubeCredentialError extends Error { constructor(message) { super(message); this.statusCode = 500; } }
export class YouTubeAuthorizationError extends Error { constructor(message, options) { super(message, options); this.statusCode = 400; } }
