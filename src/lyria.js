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

  const audio = interaction.output_audio;
  if (!audio?.data) {
    throw new UpstreamResponseError("Lyria completed the request but returned no MP3 audio.");
  }
  return audio.data;
}

export function toPublicError(error) {
  if (error?.statusCode && error.statusCode < 500) {
    return { status: error.statusCode, message: error.message };
  }

  const status = Number(error?.status ?? error?.code);
  if (status === 429) {
    return { status: 429, message: "Lyria is rate limited. Wait a moment, then choose when to try again." };
  }
  if (status === 401 || status === 403) {
    return { status: 502, message: "Google rejected the API credentials or access. Check the key and Lyria access." };
  }
  if (error instanceof ConfigurationError || error instanceof UpstreamResponseError) {
    return { status: 500, message: error.message };
  }
  return { status: 502, message: "Music generation failed. No automatic retry was made; you have not been charged by another attempt." };
}

export class ConfigurationError extends Error {}
export class UpstreamResponseError extends Error {}
