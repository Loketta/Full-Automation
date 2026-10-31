import { GoogleGenAI } from "@google/genai";
import { buildInstrumentalPrompt } from "./prompt.js";

export const LYRIA_MODEL = "lyria-3.5";

export function createLyriaClient(apiKey) {
  if (!apiKey) {
    throw new ConfigurationError("GEMINI_API_KEY is missing. Add it to your local .env file.");
  }
  return new GoogleGenAI({ apiKey });
}

export async function generateInstrumental(client, prompt) {
  // One explicit call, with no automatic application-level retry.
  const interaction = await client.interactions.create({
    model: LYRIA_MODEL,
    input: buildInstrumentalPrompt(prompt),
    response_format: { type: "audio" },
  });

  const audioData = extractMp3FromSteps(interaction.steps);
  if (!audioData) {
    throw new UpstreamResponseError("Lyria completed the request but returned no MP3 audio.");
  }
  return audioData;
}

export function extractMp3FromSteps(steps) {
  if (!Array.isArray(steps)) return undefined;

  for (const step of steps) {
    if (step?.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const content of step.content) {
      if (content?.type !== "audio" || !content.data) continue;
      const mimeType = content.mime_type?.toLowerCase();
      if (!mimeType || mimeType === "audio/mpeg" || mimeType === "audio/mp3") {
        return content.data;
      }
    }
  }

  return undefined;
}

export function toPublicError(error) {
  if (error?.statusCode && error.statusCode < 500) {
    return { status: error.statusCode, message: error.message };
  }

  const status = getHttpStatus(error);
  if (status === 400 && isLegacySchemaError(error)) {
    return { status: 502, message: "This installation is using an incompatible Google SDK schema. Stop the server, run npm ci, restart it, and confirm @google/genai is version 2.0.0 or newer before trying again." };
  }
  if (status === 429) {
    return { status: 429, message: "Google rate-limited the request or the project has no available quota. Check Gemini API billing and quota, then wait before choosing to try again." };
  }
  if (status === 401 || status === 403) {
    return { status: 502, message: "Google rejected the API key or this project does not have Lyria access. Check GEMINI_API_KEY, billing, API restrictions, and Lyria availability for the project." };
  }
  if (status === 400) {
    return { status: 502, message: "Google rejected the Lyria request. Check the prompt for unsupported content, then review the detailed diagnostic in the VS Code terminal." };
  }
  if (status === 404) {
    return { status: 502, message: "Google could not find Lyria 3.5 for this API project. Check that the project can access model lyria-3.5 and review the terminal diagnostic." };
  }
  if (status >= 500 && status <= 599) {
    return { status: 502, message: "Google's Lyria service returned a server error. Check the terminal diagnostic and Google service status before choosing to try again." };
  }
  if (isNetworkError(error)) {
    return { status: 502, message: "The server could not reach Google. Check your internet connection, proxy, or firewall, then choose whether to try again." };
  }
  if (error instanceof ConfigurationError || error instanceof UpstreamResponseError) {
    return { status: 500, message: error.message };
  }
  return { status: 502, message: "Music generation failed. Review the detailed diagnostic in the VS Code terminal. No automatic retry was made." };
}

export function createSafeDiagnostic(error, secrets = []) {
  const providerError = isRecord(error?.error) ? error.error : {};
  const cause = isRecord(error?.cause) ? error.cause : {};
  const diagnostic = {
    name: safeText(error?.name, secrets) || "Error",
    httpStatus: getHttpStatus(error) || undefined,
    providerCode: safeText(providerError.status ?? providerError.code, secrets) || undefined,
    message: safeText(providerError.message ?? error?.message, secrets) || "No error message supplied",
    requestId: getRequestId(error, secrets),
    networkCode: safeText(cause.code ?? error?.errno, secrets) || undefined,
  };

  return Object.fromEntries(Object.entries(diagnostic).filter(([, value]) => value !== undefined));
}

function getHttpStatus(error) {
  const candidate = error?.status ?? error?.statusCode ?? error?.error?.code;
  const status = Number(candidate);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function getRequestId(error, secrets) {
  const headers = error?.headers;
  const fromHeaders = typeof headers?.get === "function"
    ? headers.get("x-goog-request-id") ?? headers.get("x-request-id")
    : undefined;
  return safeText(error?.requestId ?? fromHeaders, secrets) || undefined;
}

function isNetworkError(error) {
  return error?.name === "APIConnectionError"
    || error?.name === "APIConnectionTimeoutError"
    || error?.cause?.code === "ETIMEDOUT"
    || error?.cause?.code === "ECONNRESET"
    || error?.cause?.code === "ENOTFOUND";
}

function isLegacySchemaError(error) {
  const message = `${error?.message ?? ""} ${error?.error?.message ?? ""}`;
  return /legacy interactions api schema|upgrade your @google\/genai/i.test(message);
}

function safeText(value, secrets) {
  if (value === undefined || value === null) return "";
  let text = String(value).replace(/[\r\n\t]+/g, " ").slice(0, 1000);
  for (const secret of secrets) {
    if (secret) text = text.split(String(secret)).join("[REDACTED]");
  }
  return text
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]")
    .replace(/([?&](?:key|api_key|apiKey)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(?:authorization|x-goog-api-key)\s*[:=]\s*(?:bearer\s+)?\S+/gi, "authentication credential: [REDACTED]");
}

function isRecord(value) {
  return value !== null && typeof value === "object";
}

export class ConfigurationError extends Error {}
export class UpstreamResponseError extends Error {}
